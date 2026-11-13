-- Retention requirements: PRD section 9.
-- Supabase scheduled-function pattern: https://supabase.com/docs/guides/functions/schedule-functions
alter table public.legal_settings
  add column recording_retention_days integer not null default 90 check (recording_retention_days between 30 and 365),
  add column transcript_retention_days integer not null default 365 check (transcript_retention_days between 30 and 365);

create or replace function public.update_legal_settings(
  p_recording_notice text,
  p_recording_enabled boolean,
  p_transcript_enabled boolean,
  p_recording_retention_days integer,
  p_transcript_retention_days integer
) returns public.legal_settings language plpgsql security definer set search_path = '' as $$
declare v_restaurant_id uuid; v_result public.legal_settings;
begin
  if p_recording_retention_days not between 30 and 365 or p_transcript_retention_days not between 30 and 365 then
    raise exception 'RETENTION_DAYS_OUT_OF_RANGE' using errcode='22023';
  end if;
  select r.id into v_restaurant_id from public.restaurants r join public.memberships m on m.organization_id=r.organization_id
    where m.user_id=(select auth.uid()) and m.role='owner' order by r.created_at limit 1;
  if v_restaurant_id is null then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  update public.legal_settings set recording_notice=trim(p_recording_notice), recording_enabled=p_recording_enabled,
    transcript_enabled=p_transcript_enabled, recording_retention_days=p_recording_retention_days,
    transcript_retention_days=p_transcript_retention_days
    where restaurant_id=v_restaurant_id returning * into v_result;
  return v_result;
end
$$;
revoke execute on function public.update_legal_settings(text,boolean,boolean,integer,integer) from public;
grant execute on function public.update_legal_settings(text,boolean,boolean,integer,integer) to authenticated;

create or replace function public.prepare_retention(p_now timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_paths jsonb; v_recordings integer; v_transcripts integer;
begin
  select coalesce(jsonb_agg(c.recording_path order by c.id),'[]'::jsonb), count(*)::integer
    into v_paths,v_recordings
  from public.calls c join public.legal_settings l on l.restaurant_id=c.restaurant_id
  where c.recording_path is not null and c.started_at < p_now - make_interval(days=>l.recording_retention_days);
  select count(distinct c.id)::integer into v_transcripts
  from public.calls c join public.legal_settings l on l.restaurant_id=c.restaurant_id
  where c.started_at < p_now - make_interval(days=>l.transcript_retention_days)
    and exists(select 1 from public.call_turns t where t.call_id=c.id);
  return jsonb_build_object('recording_paths',v_paths,'recordings',v_recordings,'transcripts',v_transcripts);
end
$$;

create or replace function public.execute_retention(
  p_now timestamptz,
  p_dry_run boolean default false,
  p_removed_recording_paths text[] default '{}'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_plan jsonb; v_recordings integer; v_transcripts integer; v_pending text;
begin
  v_plan := public.prepare_retention(p_now);
  v_recordings := (v_plan->>'recordings')::integer;
  v_transcripts := (v_plan->>'transcripts')::integer;
  if not p_dry_run then
    select c.recording_path into v_pending
    from public.calls c join public.legal_settings l on l.restaurant_id=c.restaurant_id
    where c.recording_path is not null and c.started_at < p_now - make_interval(days=>l.recording_retention_days)
      and not (c.recording_path=any(coalesce(p_removed_recording_paths,'{}'::text[]))) limit 1;
    if v_pending is not null then raise exception 'RETENTION_STORAGE_OBJECT_PENDING' using errcode='40001'; end if;
    update public.calls c set recording_path=null
      from public.legal_settings l where l.restaurant_id=c.restaurant_id and c.recording_path is not null
      and c.started_at < p_now - make_interval(days=>l.recording_retention_days);
    delete from public.call_turns t using public.calls c, public.legal_settings l
      where t.call_id=c.id and l.restaurant_id=c.restaurant_id
      and c.started_at < p_now - make_interval(days=>l.transcript_retention_days);
  end if;
  insert into public.audit_log(actor_id,action,target,reason) values(
    null, case when p_dry_run then 'retention.dry_run' else 'retention.executed' end, 'system:retention',
    format('recordings=%s transcripts=%s cutoff=%s',v_recordings,v_transcripts,p_now)
  );
  return jsonb_build_object('recordings',v_recordings,'transcripts',v_transcripts);
end
$$;

revoke execute on function public.prepare_retention(timestamptz) from public;
revoke execute on function public.execute_retention(timestamptz,boolean,text[]) from public;
grant execute on function public.prepare_retention(timestamptz) to service_role;
grant execute on function public.execute_retention(timestamptz,boolean,text[]) to service_role;

create or replace function public.prepare_restaurant_privacy_deletion(
  p_actor_id uuid, p_organization_id uuid, p_restaurant_id uuid
) returns text[] language plpgsql security definer set search_path = '' as $$
declare v_paths text[];
begin
  if not exists(select 1 from public.memberships where user_id=p_actor_id and organization_id=p_organization_id and role='owner')
    or not exists(select 1 from public.restaurants where id=p_restaurant_id and organization_id=p_organization_id) then
    raise exception 'PRIVACY_REQUEST_FORBIDDEN' using errcode='42501';
  end if;
  select coalesce(array_agg(recording_path order by id),'{}'::text[]) into v_paths
    from public.calls where restaurant_id=p_restaurant_id and recording_path is not null;
  return v_paths;
end
$$;

create or replace function public.execute_restaurant_privacy_request(
  p_actor_id uuid, p_organization_id uuid, p_restaurant_id uuid, p_request_type text,
  p_removed_recording_paths text[] default '{}'
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_result jsonb; v_request_id uuid := gen_random_uuid();
begin
  if p_request_type not in ('export','delete') then raise exception 'PRIVACY_REQUEST_INVALID_TYPE' using errcode='22023'; end if;
  if not exists(select 1 from public.memberships where user_id=p_actor_id and organization_id=p_organization_id and role='owner')
    or not exists(select 1 from public.restaurants where id=p_restaurant_id and organization_id=p_organization_id) then
    raise exception 'PRIVACY_REQUEST_FORBIDDEN' using errcode='42501';
  end if;
  if p_request_type='export' then
    select jsonb_build_object(
      'restaurant',to_jsonb(r),
      'hours',coalesce((select jsonb_agg(to_jsonb(x)) from public.hours x where x.restaurant_id=r.id),'[]'::jsonb),
      'hoursOverrides',coalesce((select jsonb_agg(to_jsonb(x)) from public.hours_overrides x where x.restaurant_id=r.id),'[]'::jsonb),
      'menuItems',coalesce((select jsonb_agg(to_jsonb(x)) from public.menu_items x where x.restaurant_id=r.id),'[]'::jsonb),
      'menuModifiers',coalesce((select jsonb_agg(to_jsonb(x)) from public.menu_modifiers x join public.menu_items m on m.id=x.menu_item_id where m.restaurant_id=r.id),'[]'::jsonb),
      'faqs',coalesce((select jsonb_agg(to_jsonb(x)) from public.faqs x where x.restaurant_id=r.id),'[]'::jsonb),
      'agents',coalesce((select jsonb_agg(to_jsonb(x)) from public.agents x where x.restaurant_id=r.id),'[]'::jsonb),
      'agentVersions',coalesce((select jsonb_agg(to_jsonb(x)) from public.agent_versions x join public.agents a on a.id=x.agent_id where a.restaurant_id=r.id),'[]'::jsonb),
      'audioCache',coalesce((select jsonb_agg(to_jsonb(x)) from public.audio_cache x join public.agent_versions v on v.id=x.agent_version_id join public.agents a on a.id=v.agent_id where a.restaurant_id=r.id),'[]'::jsonb),
      'phoneNumbers',coalesce((select jsonb_agg(to_jsonb(x)) from public.phone_numbers x where x.restaurant_id=r.id),'[]'::jsonb),
      'calls',coalesce((select jsonb_agg(to_jsonb(x)) from public.calls x where x.restaurant_id=r.id),'[]'::jsonb),
      'callTurns',coalesce((select jsonb_agg(to_jsonb(t)) from public.call_turns t join public.calls c on c.id=t.call_id where c.restaurant_id=r.id),'[]'::jsonb),
      'callMetrics',coalesce((select jsonb_agg(to_jsonb(x)) from public.call_metrics x join public.calls c on c.id=x.call_id where c.restaurant_id=r.id),'[]'::jsonb),
      'toolInvocations',coalesce((select jsonb_agg(to_jsonb(x)) from public.tool_invocations x join public.calls c on c.id=x.call_id where c.restaurant_id=r.id),'[]'::jsonb),
      'slotsConfig',coalesce((select jsonb_agg(to_jsonb(x)) from public.slots_config x where x.restaurant_id=r.id),'[]'::jsonb),
      'bookings',coalesce((select jsonb_agg(to_jsonb(x)) from public.bookings x where x.restaurant_id=r.id),'[]'::jsonb),
      'orders',coalesce((select jsonb_agg(to_jsonb(x)) from public.orders x where x.restaurant_id=r.id),'[]'::jsonb),
      'orderItems',coalesce((select jsonb_agg(to_jsonb(x)) from public.order_items x join public.orders o on o.id=x.order_id where o.restaurant_id=r.id),'[]'::jsonb),
      'messages',coalesce((select jsonb_agg(to_jsonb(x)) from public.messages x where x.restaurant_id=r.id),'[]'::jsonb),
      'smsLog',coalesce((select jsonb_agg(to_jsonb(x)) from public.sms_log x where x.restaurant_id=r.id),'[]'::jsonb),
      'smsOptouts',coalesce((select jsonb_agg(to_jsonb(x)) from public.sms_optouts x where x.restaurant_id=r.id),'[]'::jsonb),
      'legalSettings',coalesce((select jsonb_agg(to_jsonb(x)) from public.legal_settings x where x.restaurant_id=r.id),'[]'::jsonb),
      'importJobs',coalesce((select jsonb_agg(to_jsonb(x)) from public.import_jobs x where x.restaurant_id=r.id),'[]'::jsonb),
      'importReviewRows',coalesce((select jsonb_agg(to_jsonb(x)) from public.import_review_rows x where x.restaurant_id=r.id),'[]'::jsonb)
    ) into v_result from public.restaurants r where r.id=p_restaurant_id;
  else
    if exists(select 1 from public.calls where restaurant_id=p_restaurant_id and recording_path is not null
      and not (recording_path=any(coalesce(p_removed_recording_paths,'{}'::text[])))) then
      raise exception 'PRIVACY_REQUEST_RECORDINGS_PENDING' using errcode='40001';
    end if;
    delete from public.restaurants where id=p_restaurant_id and organization_id=p_organization_id;
    v_result := jsonb_build_object('restaurantDeleted',true);
  end if;
  insert into public.audit_log(actor_id,action,target,reason) values(
    p_actor_id,'privacy_request.restaurant.'||p_request_type,'restaurant:'||p_restaurant_id,
    case when p_request_type='delete' then 'Owner-approved restaurant data deletion completed' else 'Owner-requested restaurant data export completed' end
  );
  return jsonb_build_object('id',v_request_id,'status','completed','request_type',p_request_type,
    'verification_status','verified','due_at',now(),'result',v_result);
end
$$;
revoke execute on function public.prepare_restaurant_privacy_deletion(uuid,uuid,uuid) from public;
revoke execute on function public.execute_restaurant_privacy_request(uuid,uuid,uuid,text,text[]) from public;
grant execute on function public.prepare_restaurant_privacy_deletion(uuid,uuid,uuid) to service_role;
grant execute on function public.execute_restaurant_privacy_request(uuid,uuid,uuid,text,text[]) to service_role;
