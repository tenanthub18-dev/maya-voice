-- Recording guidance: https://www.priv.gc.ca/en/privacy-topics/surveillance/02_05_d_14/
-- Quebec privacy guidance: https://www.cai.gouv.qc.ca/protection-renseignements-personnels/sujets-et-domaines-dinteret/principaux-changements-loi-25

create table public.legal_settings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  restaurant_id uuid not null unique references public.restaurants(id) on delete cascade,
  recording_notice text not null check (length(trim(recording_notice)) > 0),
  recording_enabled boolean not null default true,
  transcript_enabled boolean not null default true,
  legal_review_required boolean not null default true,
  privacy_policy_url text not null default '/privacy'
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider_invoice_id text unique,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  total_cents integer not null check (total_cents >= 0),
  status text not null check (status in ('open','paid','void'))
);

create table public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  request_type text not null check (request_type in ('export','delete')),
  status text not null default 'received' check (status in ('received','verified','fulfilling','completed','rejected')),
  verification_status text not null default 'required' check (verification_status in ('required','verified','rejected')),
  caller_phone_hash text not null check (caller_phone_hash ~ '^[0-9a-f]{64}$'),
  caller_phone_last4 text not null check (caller_phone_last4 ~ '^[0-9]{4}$'),
  requested_by uuid not null references auth.users(id) on delete restrict,
  due_at timestamptz not null default (now() + interval '30 days'),
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  verification_method text check (verification_method in ('callback','account-record','written-document')),
  verification_reference text,
  completed_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  rejected_by uuid references auth.users(id) on delete set null,
  rejected_at timestamptz,
  decision_reason text,
  result jsonb
  ,fulfillment_cutoff timestamptz
  ,fulfillment_manifest jsonb
  ,fulfillment_started_at timestamptz
  ,result_expires_at timestamptz
);

create trigger set_legal_settings_updated_at before update on public.legal_settings
for each row execute function private.set_updated_at();
create trigger set_invoices_updated_at before update on public.invoices
for each row execute function private.set_updated_at();
create trigger set_privacy_requests_updated_at before update on public.privacy_requests
for each row execute function private.set_updated_at();

create index invoices_organization_period_idx on public.invoices(organization_id, period desc);
create index privacy_requests_organization_created_idx on public.privacy_requests(organization_id, created_at desc);
create index privacy_requests_restaurant_hash_idx on public.privacy_requests(restaurant_id, caller_phone_hash);
create unique index privacy_requests_one_active_idx on public.privacy_requests(restaurant_id,request_type,caller_phone_hash)
where status in ('received','verified','fulfilling');

create or replace function private.default_recording_notice(p_province text)
returns text language sql immutable set search_path = '' as $$
  select case when p_province = 'QC' then
    'Cet appel peut être enregistré afin de mieux vous servir. En poursuivant, vous consentez à l’enregistrement. Vous pouvez nous demander de continuer sans enregistrer l’appel.' || E'\n\n' ||
    'This call may be recorded to help us serve you. By continuing, you consent to the recording. You may ask us to continue without recording.'
  else
    'This call may be recorded to help us serve you. By continuing, you consent to the recording. You may ask us to continue without recording.' || E'\n\n' ||
    'Cet appel peut être enregistré afin de mieux vous servir. En poursuivant, vous consentez à l’enregistrement. Vous pouvez nous demander de continuer sans enregistrer l’appel.'
  end
$$;

insert into public.legal_settings(restaurant_id, recording_notice)
select id, private.default_recording_notice(province) from public.restaurants
on conflict (restaurant_id) do nothing;

create or replace function private.create_restaurant_legal_settings()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.legal_settings(restaurant_id, recording_notice)
  values(new.id, private.default_recording_notice(new.province));
  return new;
end
$$;
create trigger restaurants_create_legal_settings after insert on public.restaurants
for each row execute function private.create_restaurant_legal_settings();

create or replace function private.refresh_default_recording_notice_for_province()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.legal_settings set recording_notice=replace(
    recording_notice, private.default_recording_notice(old.province), private.default_recording_notice(new.province)
  ) where restaurant_id=new.id and position(private.default_recording_notice(old.province) in recording_notice)>0;
  return new;
end
$$;
create trigger restaurants_refresh_default_recording_notice after update of province on public.restaurants
for each row when (old.province is distinct from new.province)
execute function private.refresh_default_recording_notice_for_province();

alter table public.legal_settings enable row level security;
alter table public.invoices enable row level security;
alter table public.privacy_requests enable row level security;
revoke all on public.legal_settings, public.invoices, public.privacy_requests from anon, authenticated;
grant select on public.invoices to authenticated;

create policy legal_settings_select on public.legal_settings for select to authenticated
using (restaurant_id in (select private.user_restaurant_ids()));
create policy legal_settings_member_update on public.legal_settings for update to authenticated
using (restaurant_id in (select private.user_restaurant_ids()))
with check (restaurant_id in (select private.user_restaurant_ids()));
create policy invoices_select on public.invoices for select to authenticated
using (organization_id in (select private.user_organization_ids()));
create policy privacy_requests_select on public.privacy_requests for select to authenticated
using (organization_id in (select private.user_organization_ids()));

create or replace function public.get_legal_settings()
returns public.legal_settings language plpgsql security definer stable set search_path = '' as $$
declare v_settings public.legal_settings;
begin
  select l.* into v_settings from public.legal_settings l
  where l.restaurant_id in (select private.user_restaurant_ids()) limit 1;
  if not found then raise exception 'LEGAL_SETTINGS_NOT_FOUND' using errcode='P0002'; end if;
  return v_settings;
end
$$;

create or replace function public.update_legal_settings(
  p_recording_notice text, p_recording_enabled boolean, p_transcript_enabled boolean
) returns public.legal_settings language plpgsql security definer set search_path = '' as $$
declare v_settings public.legal_settings;
begin
  if length(trim(p_recording_notice)) = 0 then raise exception 'RECORDING_NOTICE_REQUIRED' using errcode='23514'; end if;
  if not exists(
    select 1 from public.restaurants r
    where r.id in (select private.user_restaurant_ids())
      and position(private.default_recording_notice(r.province) in p_recording_notice) > 0
  ) then raise exception 'MANDATORY_RECORDING_DISCLOSURE_REQUIRED' using errcode='23514'; end if;
  update public.legal_settings l set recording_notice=trim(p_recording_notice),
    recording_enabled=p_recording_enabled, transcript_enabled=p_transcript_enabled
  where private.is_restaurant_owner(l.restaurant_id) returning * into v_settings;
  if not found then raise exception 'LEGAL_SETTINGS_NOT_FOUND' using errcode='P0002'; end if;
  return v_settings;
end
$$;

revoke execute on function public.get_legal_settings() from public;
revoke execute on function public.update_legal_settings(text,boolean,boolean) from public;
grant execute on function public.get_legal_settings() to authenticated;
grant execute on function public.update_legal_settings(text,boolean,boolean) to authenticated;

create or replace function public.create_privacy_request(
  p_actor_id uuid, p_organization_id uuid, p_restaurant_id uuid, p_request_type text,
  p_caller_phone_hash text, p_caller_phone_last4 text
) returns public.privacy_requests language plpgsql security definer set search_path = '' as $$
declare v_request public.privacy_requests;
begin
  perform pg_advisory_xact_lock(hashtextextended('privacy-rate:' || p_organization_id::text,0));
  if not exists(select 1 from public.memberships where user_id=p_actor_id and organization_id=p_organization_id) then
    raise exception 'PRIVACY_REQUEST_FORBIDDEN' using errcode='42501';
  end if;
  if not exists(select 1 from public.restaurants where id=p_restaurant_id and organization_id=p_organization_id) then
    raise exception 'PRIVACY_REQUEST_RESTAURANT_NOT_FOUND' using errcode='P0002';
  end if;
  if (select count(*) from public.privacy_requests where organization_id=p_organization_id and created_at>now()-interval '1 hour') >= 30 then
    raise exception 'PRIVACY_REQUEST_RATE_LIMITED' using errcode='P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('privacy-active:' || p_organization_id::text || ':' || p_caller_phone_hash,0));
  select * into v_request from public.privacy_requests
  where organization_id=p_organization_id and restaurant_id=p_restaurant_id
    and request_type=p_request_type and caller_phone_hash=p_caller_phone_hash
    and status in ('received','verified','fulfilling') order by created_at desc limit 1;
  if found then return v_request; end if;
  insert into public.privacy_requests(
    organization_id, restaurant_id, request_type, caller_phone_hash, caller_phone_last4, requested_by
  ) values(
    p_organization_id, p_restaurant_id, p_request_type, p_caller_phone_hash, p_caller_phone_last4, p_actor_id
  ) returning * into v_request;
  insert into public.audit_log(actor_id, action, target, reason) values(
    p_actor_id, 'privacy_request.' || p_request_type || '.received',
    'privacy-request:' || v_request.id || ':caller:' || p_caller_phone_hash,
    'Caller request received; identity verification required; phone ending ' || p_caller_phone_last4
  );
  return v_request;
end
$$;

create or replace function public.transition_privacy_request(
  p_actor_id uuid, p_organization_id uuid, p_request_id uuid, p_action text, p_reason text default null,
  p_verification_method text default null, p_verification_reference text default null,
  p_caller_phone_e164 text default null, p_caller_phone_hash text default null,
  p_removed_recording_paths text[] default '{}'::text[]
) returns public.privacy_requests language plpgsql security definer set search_path = '' as $$
declare
  v_request public.privacy_requests;
  v_result jsonb;
  v_bookings integer := 0;
  v_orders integer := 0;
  v_messages integer := 0;
  v_calls integer := 0;
begin
  if not exists(select 1 from public.memberships where user_id=p_actor_id and organization_id=p_organization_id and role='owner') then
    raise exception 'PRIVACY_REQUEST_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_request from public.privacy_requests
  where id=p_request_id and organization_id=p_organization_id for update;
  if not found then raise exception 'PRIVACY_REQUEST_NOT_FOUND' using errcode='P0002'; end if;

  if p_action='verify' then
    if v_request.status <> 'received' or p_verification_method not in ('callback','account-record','written-document')
      or nullif(trim(p_verification_reference),'') is null
      or p_verification_reference ~ '\+[1-9][0-9]{7,14}' then
      raise exception 'VERIFICATION_EVIDENCE_REQUIRED' using errcode='23514';
    end if;
    update public.privacy_requests set status='verified', verification_status='verified',
      verified_by=p_actor_id, verified_at=now(), verification_method=p_verification_method,
      verification_reference=trim(p_verification_reference) where id=p_request_id returning * into v_request;
  elsif p_action='reject' then
    if v_request.status not in ('received','verified') or nullif(trim(p_reason),'') is null then
      raise exception 'PRIVACY_REQUEST_INVALID_TRANSITION' using errcode='23514';
    end if;
    update public.privacy_requests set status='rejected', verification_status='rejected',
      rejected_by=p_actor_id, rejected_at=now(), decision_reason=trim(p_reason)
      where id=p_request_id returning * into v_request;
  elsif p_action='fulfill' then
    if v_request.status not in ('verified','fulfilling') or v_request.verification_status <> 'verified' then
      raise exception 'PRIVACY_REQUEST_NOT_VERIFIED' using errcode='23514';
    end if;
    if p_caller_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' or p_caller_phone_hash is distinct from v_request.caller_phone_hash then
      raise exception 'PRIVACY_REQUEST_CALLER_MISMATCH' using errcode='23514';
    end if;
    if v_request.request_type='export' then
      select jsonb_build_object(
        'bookings', coalesce((select jsonb_agg(to_jsonb(b)) from public.bookings b where b.restaurant_id=v_request.restaurant_id and b.phone_e164=p_caller_phone_e164 and b.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'orders', coalesce((select jsonb_agg(to_jsonb(o)) from public.orders o where o.restaurant_id=v_request.restaurant_id and o.phone=p_caller_phone_e164 and o.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'orderItems', coalesce((select jsonb_agg(to_jsonb(i)) from public.order_items i join public.orders o on o.id=i.order_id where o.restaurant_id=v_request.restaurant_id and o.phone=p_caller_phone_e164 and o.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'messages', coalesce((select jsonb_agg(to_jsonb(m)) from public.messages m where m.restaurant_id=v_request.restaurant_id and m.phone=p_caller_phone_e164 and m.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'calls', coalesce((select jsonb_agg(to_jsonb(c)) from public.calls c where c.restaurant_id=v_request.restaurant_id and c.from_e164_hash=v_request.caller_phone_hash and c.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'callTurns', coalesce((select jsonb_agg(to_jsonb(t)) from public.call_turns t join public.calls c on c.id=t.call_id where c.restaurant_id=v_request.restaurant_id and c.from_e164_hash=v_request.caller_phone_hash and c.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'callMetrics', coalesce((select jsonb_agg(to_jsonb(m)) from public.call_metrics m join public.calls c on c.id=m.call_id where c.restaurant_id=v_request.restaurant_id and c.from_e164_hash=v_request.caller_phone_hash and c.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'toolInvocations', coalesce((select jsonb_agg(to_jsonb(t)) from public.tool_invocations t join public.calls c on c.id=t.call_id where c.restaurant_id=v_request.restaurant_id and c.from_e164_hash=v_request.caller_phone_hash and c.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'smsLog', coalesce((select jsonb_agg(to_jsonb(s)) from public.sms_log s where s.restaurant_id=v_request.restaurant_id and s.to_e164=p_caller_phone_e164 and s.created_at<=v_request.fulfillment_cutoff), '[]'::jsonb),
        'smsOptOuts', coalesce((select jsonb_agg(to_jsonb(s)) from public.sms_optouts s where s.restaurant_id=v_request.restaurant_id and s.phone_e164=p_caller_phone_e164), '[]'::jsonb)
      ) into v_result;
    else
      perform 1 from public.calls c where c.restaurant_id=v_request.restaurant_id
        and c.from_e164_hash=v_request.caller_phone_hash and c.created_at<=v_request.fulfillment_cutoff for update;
      if exists(
        select 1 from public.calls c where c.restaurant_id=v_request.restaurant_id
          and c.from_e164_hash=v_request.caller_phone_hash and c.created_at<=v_request.fulfillment_cutoff
          and c.recording_path is not null and not (c.recording_path=any(coalesce(p_removed_recording_paths,'{}'::text[])))
      ) then raise exception 'PRIVACY_REQUEST_RECORDINGS_PENDING' using errcode='40001'; end if;
      delete from public.bookings where restaurant_id=v_request.restaurant_id and phone_e164=p_caller_phone_e164 and created_at<=v_request.fulfillment_cutoff;
      get diagnostics v_bookings = row_count;
      update public.orders set name='Deleted caller', phone='' where restaurant_id=v_request.restaurant_id and phone=p_caller_phone_e164 and created_at<=v_request.fulfillment_cutoff;
      get diagnostics v_orders = row_count;
      delete from public.messages where restaurant_id=v_request.restaurant_id and phone=p_caller_phone_e164 and created_at<=v_request.fulfillment_cutoff;
      get diagnostics v_messages = row_count;
      delete from public.call_turns where call_id in (
        select id from public.calls where restaurant_id=v_request.restaurant_id and from_e164_hash=v_request.caller_phone_hash and created_at<=v_request.fulfillment_cutoff
      );
      delete from public.tool_invocations where call_id in (
        select id from public.calls where restaurant_id=v_request.restaurant_id and from_e164_hash=v_request.caller_phone_hash and created_at<=v_request.fulfillment_cutoff
      );
      update public.calls set from_e164_hash='deleted:' || p_request_id::text, from_last4='0000',
        recording_path=null, summary='' where restaurant_id=v_request.restaurant_id and from_e164_hash=v_request.caller_phone_hash and created_at<=v_request.fulfillment_cutoff;
      get diagnostics v_calls = row_count;
      delete from public.sms_log where restaurant_id=v_request.restaurant_id and to_e164=p_caller_phone_e164;
      v_result := jsonb_build_object('bookingsDeleted',v_bookings,'ordersRedacted',v_orders,'messagesDeleted',v_messages,'callsRedacted',v_calls,'smsOptOutRetained',true);
    end if;
    update public.privacy_requests set status='completed', completed_by=p_actor_id, completed_at=now(),
      result=v_result, result_expires_at=case when request_type='export' then now()+interval '24 hours' else null end
      where id=p_request_id returning * into v_request;
  else
    raise exception 'PRIVACY_REQUEST_INVALID_ACTION' using errcode='22023';
  end if;

  insert into public.audit_log(actor_id, action, target, reason) values(
    p_actor_id, 'privacy_request.' || v_request.request_type || '.' || p_action,
    'privacy-request:' || v_request.id || ':caller:' || v_request.caller_phone_hash,
    case when p_action='reject' then trim(p_reason)
      when p_action='verify' then 'Identity verified by ' || p_verification_method || '; reference ' || trim(p_verification_reference)
      else case when v_request.request_type='delete' then 'Reserved storage manifest removed; deletion completed; phone ending '
        else 'Request lifecycle advanced; phone ending ' end || v_request.caller_phone_last4 end
  );
  return v_request;
end
$$;

create or replace function public.prepare_privacy_request_fulfillment(
  p_actor_id uuid, p_organization_id uuid, p_request_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_request public.privacy_requests;
begin
  if not exists(select 1 from public.memberships where user_id=p_actor_id and organization_id=p_organization_id and role='owner') then
    raise exception 'PRIVACY_REQUEST_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_request from public.privacy_requests
  where id=p_request_id and organization_id=p_organization_id for update;
  if not found then raise exception 'PRIVACY_REQUEST_NOT_FOUND' using errcode='P0002'; end if;
  if v_request.status not in ('verified','fulfilling') or v_request.verification_status <> 'verified' then
    raise exception 'PRIVACY_REQUEST_NOT_VERIFIED' using errcode='23514';
  end if;
  if v_request.status='verified' then
    update public.privacy_requests set status='fulfilling', fulfillment_cutoff=now(), fulfillment_started_at=now(),
      fulfillment_manifest=jsonb_build_object('recording_paths','[]'::jsonb)
      where id=p_request_id returning * into v_request;
    insert into public.audit_log(actor_id,action,target,reason) values(p_actor_id,'privacy_request.fulfillment_reserved',
      'privacy-request:'||v_request.id||':caller:'||v_request.caller_phone_hash,'Fulfillment cutoff and storage manifest reserved');
  end if;
  update public.privacy_requests p set fulfillment_manifest=jsonb_build_object('recording_paths',coalesce((
    select jsonb_agg(paths.path) from (
      select jsonb_array_elements_text(coalesce(p.fulfillment_manifest->'recording_paths','[]'::jsonb)) path
      union
      select c.recording_path from public.calls c where c.restaurant_id=p.restaurant_id
        and c.from_e164_hash=p.caller_phone_hash and c.created_at<=p.fulfillment_cutoff and c.recording_path is not null
    ) paths
  ),'[]'::jsonb)) where p.id=p_request_id returning * into v_request;
  return jsonb_build_object(
    'request_type', v_request.request_type,
    'recording_paths', coalesce(v_request.fulfillment_manifest->'recording_paths',(
      select jsonb_agg(c.recording_path) from public.calls c
      where c.restaurant_id=v_request.restaurant_id and c.from_e164_hash=v_request.caller_phone_hash and c.recording_path is not null
    ), '[]'::jsonb)
  );
end
$$;

revoke execute on function public.create_privacy_request(uuid,uuid,uuid,text,text,text) from public;
revoke execute on function public.transition_privacy_request(uuid,uuid,uuid,text,text,text,text,text,text,text[]) from public;
revoke execute on function public.prepare_privacy_request_fulfillment(uuid,uuid,uuid) from public;
grant execute on function public.create_privacy_request(uuid,uuid,uuid,text,text,text) to service_role;
grant execute on function public.transition_privacy_request(uuid,uuid,uuid,text,text,text,text,text,text,text[]) to service_role;
grant execute on function public.prepare_privacy_request_fulfillment(uuid,uuid,uuid) to service_role;

create or replace function public.list_privacy_requests(p_actor_id uuid,p_organization_id uuid)
returns table(id uuid,status text,request_type text,verification_status text,due_at timestamptz,result jsonb)
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.memberships where user_id=p_actor_id and organization_id=p_organization_id and role='owner') then
    raise exception 'PRIVACY_REQUEST_FORBIDDEN' using errcode='42501';
  end if;
  return query select p.id,p.status,p.request_type,p.verification_status,p.due_at,
    case when p.result_expires_at is null or p.result_expires_at>now() then p.result else null end
  from public.privacy_requests p where p.organization_id=p_organization_id order by p.created_at desc limit 100;
end
$$;

create or replace function public.purge_expired_privacy_results()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  update public.privacy_requests set result=null where result is not null and result_expires_at<=now();
  get diagnostics v_count=row_count;
  return v_count;
end
$$;
revoke execute on function public.list_privacy_requests(uuid,uuid) from public;
revoke execute on function public.purge_expired_privacy_results() from public;
grant execute on function public.list_privacy_requests(uuid,uuid) to service_role;
grant execute on function public.purge_expired_privacy_results() to service_role;
