-- Supabase JWT app_metadata is suitable for authorization because users cannot
-- update it themselves: https://supabase.com/docs/guides/database/postgres/row-level-security#helper-functions
create or replace function private.is_platform_admin()
returns boolean language sql security definer stable set search_path = '' as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'platform_admin', 'false') = 'true'
$$;
revoke execute on function private.is_platform_admin() from public;
grant execute on function private.is_platform_admin() to authenticated;

create table public.feature_flags (
  id uuid primary key default gen_random_uuid(),
  key text not null check (length(trim(key)) > 0),
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  enabled boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);
create unique index feature_flags_global_key_idx on public.feature_flags(key) where restaurant_id is null;
create unique index feature_flags_restaurant_key_idx on public.feature_flags(key,restaurant_id) where restaurant_id is not null;
create index feature_flags_restaurant_id_idx on public.feature_flags(restaurant_id);
create trigger set_feature_flags_updated_at before update on public.feature_flags
  for each row execute function private.set_updated_at();

create table public.support_sessions (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  reason text not null check (length(trim(reason)) >= 10),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  ended_at timestamptz,
  check (expires_at = started_at + interval '30 minutes'),
  check (ended_at is null or ended_at >= started_at)
);
create index support_sessions_admin_active_idx on public.support_sessions(admin_user_id,expires_at desc) where ended_at is null;
create index support_sessions_restaurant_id_idx on public.support_sessions(restaurant_id);

alter table public.phone_numbers add column kill_switch boolean not null default false;
alter table public.feature_flags enable row level security;
alter table public.support_sessions enable row level security;

-- Audited admin RPCs run as this non-login, non-member role. Unlike a custom
-- session setting, callers cannot manufacture this execution identity.
do $$ begin
  if not exists(select 1 from pg_roles where rolname='admin_audit_executor') then
    create role admin_audit_executor nologin noinherit;
  end if;
end $$;
alter role admin_audit_executor nologin noinherit nobypassrls;
revoke admin_audit_executor from anon,authenticated,service_role;

create or replace function private.enforce_admin_write_boundary()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name='phone_numbers' and tg_op='UPDATE'
    and (to_jsonb(new)->'kill_switch') is distinct from (to_jsonb(old)->'kill_switch')
    and current_user <> 'admin_audit_executor' then
    raise exception 'ADMIN_AUDIT_REQUIRED' using errcode='42501';
  end if;
  if (select private.is_platform_admin()) and current_user <> 'admin_audit_executor' then
    raise exception 'SUPPORT_VIEW_READ_ONLY' using errcode='42501';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;

do $$ declare v_table text; begin
  foreach v_table in array array[
    'organizations','memberships','organization_invitations','restaurants','hours','hours_overrides','menu_items','menu_modifiers','faqs',
    'agents','agent_versions','audio_cache','phone_numbers','calls','call_turns','call_metrics','tool_invocations',
    'slots_config','bookings','orders','order_items','messages','sms_log','sms_optouts','usage_ledger',
    'notification_preferences','import_jobs','import_review_rows','legal_settings','invoices','privacy_requests'
  ] loop
    execute format('create trigger %I_support_read_only before insert or update or delete on public.%I for each row execute function private.enforce_admin_write_boundary()',v_table,v_table);
  end loop;
end $$;

-- Direct mutation privileges are intentionally absent. Audited SECURITY DEFINER
-- functions below are the only admin write boundary. PostgreSQL column/table
-- grants: https://www.postgresql.org/docs/current/sql-grant.html
revoke all on public.feature_flags,public.support_sessions from anon,authenticated;
grant select on public.feature_flags,public.support_sessions to authenticated;
revoke update(kill_switch) on public.phone_numbers from authenticated;
revoke all on public.feature_flags,public.support_sessions from service_role;
revoke update(kill_switch) on public.phone_numbers from service_role;
grant usage on schema private to service_role;
grant execute on function private.is_platform_admin() to service_role,admin_audit_executor;

create policy feature_flags_platform_admin_select on public.feature_flags
  for select to authenticated using ((select private.is_platform_admin()));
create policy support_sessions_platform_admin_select on public.support_sessions
  for select to authenticated using (
    (select private.is_platform_admin()) and admin_user_id=(select auth.uid())
  );

create policy feature_flags_audited_executor on public.feature_flags
  for all to admin_audit_executor using (true) with check (true);
create policy support_sessions_audited_executor on public.support_sessions
  for all to admin_audit_executor using (true) with check (true);
create policy restaurants_audited_executor_select on public.restaurants
  for select to admin_audit_executor using (true);
create policy phone_numbers_audited_executor_select on public.phone_numbers
  for select to admin_audit_executor using (true);
create policy phone_numbers_audited_executor_update on public.phone_numbers
  for update to admin_audit_executor using (true) with check (true);
create policy calls_audited_executor_select on public.calls
  for select to admin_audit_executor using (true);
create policy calls_audited_executor_lock on public.calls
  for update to admin_audit_executor using (true) with check (true);
create policy legal_settings_audited_executor_select on public.legal_settings
  for select to admin_audit_executor using (true);

create or replace function private.has_active_support_session(p_restaurant_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select (select private.is_platform_admin()) and exists (
    select 1 from public.support_sessions session
    where session.admin_user_id=(select auth.uid())
      and session.restaurant_id=p_restaurant_id
      and session.started_at<=now()
      and session.expires_at>now()
      and session.ended_at is null
  )
$$;
revoke execute on function private.has_active_support_session(uuid) from public;
grant execute on function private.has_active_support_session(uuid) to authenticated;

-- Platform admins can discover restaurants and operational totals from /admin.
create policy organizations_platform_admin_select on public.organizations
  for select to authenticated using ((select private.is_platform_admin()));
create policy restaurants_platform_admin_select on public.restaurants
  for select to authenticated using ((select private.is_platform_admin()));
create policy phone_numbers_platform_admin_select on public.phone_numbers
  for select to authenticated using ((select private.is_platform_admin()));
create policy usage_ledger_platform_admin_select on public.usage_ledger
  for select to authenticated using ((select private.is_platform_admin()));

-- An active, unexpired support session adds SELECT only. Existing tenant write
-- policies remain membership/owner based, so support access cannot mutate data.
create policy memberships_active_support_select on public.memberships for select to authenticated using (
  exists(select 1 from public.restaurants r where r.organization_id=memberships.organization_id and (select private.has_active_support_session(r.id)))
);
create policy hours_active_support_select on public.hours for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy hours_overrides_active_support_select on public.hours_overrides for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy menu_items_active_support_select on public.menu_items for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy menu_modifiers_active_support_select on public.menu_modifiers for select to authenticated using (
  exists(select 1 from public.menu_items item where item.id=menu_item_id and (select private.has_active_support_session(item.restaurant_id)))
);
create policy faqs_active_support_select on public.faqs for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy agents_active_support_select on public.agents for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy agent_versions_active_support_select on public.agent_versions for select to authenticated using (
  exists(select 1 from public.agents agent where agent.id=agent_id and (select private.has_active_support_session(agent.restaurant_id)))
);
create policy calls_active_support_select on public.calls for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy call_turns_active_support_select on public.call_turns for select to authenticated using (
  exists(select 1 from public.calls call where call.id=call_id and (select private.has_active_support_session(call.restaurant_id)))
);
create policy call_metrics_active_support_select on public.call_metrics for select to authenticated using (
  exists(select 1 from public.calls call where call.id=call_id and (select private.has_active_support_session(call.restaurant_id)))
);
create policy tool_invocations_active_support_select on public.tool_invocations for select to authenticated using (
  exists(select 1 from public.calls call where call.id=call_id and (select private.has_active_support_session(call.restaurant_id)))
);
create policy slots_config_active_support_select on public.slots_config for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy bookings_active_support_select on public.bookings for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy orders_active_support_select on public.orders for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy order_items_active_support_select on public.order_items for select to authenticated using (
  exists(select 1 from public.orders customer_order where customer_order.id=order_id and (select private.has_active_support_session(customer_order.restaurant_id)))
);
create policy messages_active_support_select on public.messages for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy sms_log_active_support_select on public.sms_log for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy sms_optouts_active_support_select on public.sms_optouts for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy legal_settings_active_support_select on public.legal_settings for select to authenticated using ((select private.has_active_support_session(restaurant_id)));
create policy invoices_active_support_select on public.invoices for select to authenticated using (
  exists(select 1 from public.restaurants r where r.organization_id=invoices.organization_id and (select private.has_active_support_session(r.id)))
);

-- Audit rows are append-only: admin clients may only read; trusted server jobs
-- may insert but no application role receives UPDATE or DELETE.
revoke all on public.audit_log from anon,authenticated,service_role;
grant select,insert on public.audit_log to service_role;
create policy audit_log_platform_admin_select on public.audit_log
  for select to authenticated using ((select private.is_platform_admin()));
create policy audit_log_audited_executor_select on public.audit_log
  for select to admin_audit_executor using (true);
create policy audit_log_audited_executor_insert on public.audit_log
  for insert to admin_audit_executor with check (true);

create or replace function public.start_support_session(p_restaurant_id uuid,p_reason text)
returns public.support_sessions language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_now timestamptz := now(); v_session public.support_sessions; v_previous public.support_sessions;
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,'')))<10 then raise exception 'SUPPORT_REASON_REQUIRED' using errcode='22023'; end if;
  if not exists(select 1 from public.restaurants where id=p_restaurant_id) then raise exception 'RESTAURANT_NOT_FOUND' using errcode='P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_actor::text,0));
  if exists(select 1 from public.support_sessions where admin_user_id=v_actor and ended_at is null and expires_at>v_now) then
    raise exception 'SUPPORT_SESSION_ACTIVE' using errcode='55000';
  end if;
  for v_previous in update public.support_sessions set ended_at=v_now
    where admin_user_id=v_actor and ended_at is null returning *
  loop
    insert into public.audit_log(actor_id,action,target,reason) values(
      v_actor,'support_session.ended','restaurant:'||v_previous.restaurant_id||':session:'||v_previous.id,v_previous.reason
    );
  end loop;
  insert into public.support_sessions(admin_user_id,restaurant_id,reason,started_at,expires_at)
    values(v_actor,p_restaurant_id,trim(p_reason),v_now,v_now+interval '30 minutes') returning * into v_session;
  insert into public.audit_log(actor_id,action,target,reason) values(
    v_actor,'support_session.started','restaurant:'||p_restaurant_id||':session:'||v_session.id,v_session.reason
  );
  return v_session;
end $$;

create or replace function public.end_support_session(p_session_id uuid)
returns public.support_sessions language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_session public.support_sessions;
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  update public.support_sessions set ended_at=now()
    where id=p_session_id and admin_user_id=v_actor and ended_at is null returning * into v_session;
  if not found then raise exception 'SUPPORT_SESSION_INACTIVE' using errcode='P0002'; end if;
  insert into public.audit_log(actor_id,action,target,reason) values(
    v_actor,'support_session.ended','restaurant:'||v_session.restaurant_id||':session:'||v_session.id,v_session.reason
  );
  return v_session;
end $$;

create or replace function public.set_feature_flag(p_key text,p_restaurant_id uuid,p_enabled boolean)
returns public.feature_flags language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_flag public.feature_flags; v_scope text;
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  if length(trim(coalesce(p_key,'')))=0 then raise exception 'FEATURE_FLAG_KEY_REQUIRED' using errcode='22023'; end if;
  if p_restaurant_id is not null and not exists(select 1 from public.restaurants where id=p_restaurant_id) then raise exception 'RESTAURANT_NOT_FOUND' using errcode='P0002'; end if;
  if p_restaurant_id is null then
    insert into public.feature_flags(key,restaurant_id,enabled,updated_by) values(trim(p_key),null,p_enabled,v_actor)
      on conflict(key) where restaurant_id is null do update set enabled=excluded.enabled,updated_by=excluded.updated_by
      returning * into v_flag;
    v_scope := 'global';
  else
    insert into public.feature_flags(key,restaurant_id,enabled,updated_by) values(trim(p_key),p_restaurant_id,p_enabled,v_actor)
      on conflict(key,restaurant_id) where restaurant_id is not null do update set enabled=excluded.enabled,updated_by=excluded.updated_by
      returning * into v_flag;
    v_scope := 'restaurant:'||p_restaurant_id;
  end if;
  insert into public.audit_log(actor_id,action,target,reason) values(
    v_actor,'feature_flag.toggled','feature-flag:'||v_flag.key||':'||v_scope,
    case when p_enabled then 'Enabled ' else 'Disabled ' end||v_flag.key||' for '||v_scope
  );
  return v_flag;
end $$;

create or replace function public.set_phone_kill_switch(p_phone_number_id uuid,p_enabled boolean,p_reason text)
returns public.phone_numbers language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_phone public.phone_numbers;
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  if length(trim(coalesce(p_reason,'')))<10 then raise exception 'KILL_SWITCH_REASON_REQUIRED' using errcode='22023'; end if;
  update public.phone_numbers set kill_switch=p_enabled where id=p_phone_number_id returning * into v_phone;
  if not found then raise exception 'PHONE_NUMBER_NOT_FOUND' using errcode='P0002'; end if;
  insert into public.audit_log(actor_id,action,target,reason) values(
    v_actor,'phone_number.kill_switch.'||case when p_enabled then 'enabled' else 'disabled' end,
    'phone-number:'||v_phone.id,trim(p_reason)
  );
  return v_phone;
end $$;

create or replace function public.get_admin_recording_path(p_call_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_actor uuid := (select auth.uid()); v_session public.support_sessions; v_path text; v_restaurant_id uuid;
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  select restaurant_id,recording_path into v_restaurant_id,v_path from public.calls where id=p_call_id for share;
  if not found or v_path is null then raise exception 'RECORDING_NOT_FOUND' using errcode='P0002'; end if;
  select session.* into v_session from public.support_sessions session
    where session.restaurant_id=v_restaurant_id and session.admin_user_id=v_actor and session.started_at<=now()
      and session.expires_at>now() and session.ended_at is null order by session.started_at desc limit 1;
  if not found then raise exception 'SUPPORT_SESSION_REQUIRED' using errcode='42501'; end if;
  insert into public.audit_log(actor_id,action,target,reason) values(
    v_actor,'recording.read','call:'||p_call_id||':session:'||v_session.id,v_session.reason
  );
  return v_path;
end $$;

create or replace function public.list_admin_restaurant_usage()
returns table(restaurant_id uuid,name text,status text,calls bigint,minutes numeric,cost_micros bigint)
language sql security definer stable set search_path = '' as $$
  select restaurant.id,restaurant.name,restaurant.status,
    coalesce(stats.calls,0),coalesce(stats.minutes,0),coalesce(stats.cost_micros,0)
  from public.restaurants restaurant
  left join lateral (
    select count(*) calls,coalesce(sum(call.billable_seconds),0)::numeric/60 minutes,
      coalesce(sum((select coalesce(sum(cost.value::bigint),0) from jsonb_each_text(call.cost_micros) cost)),0)::bigint cost_micros
    from public.calls call where call.restaurant_id=restaurant.id
  ) stats on true
  where (select private.is_platform_admin())
  order by restaurant.name,restaurant.id
$$;

create or replace function public.list_admin_audit_logs()
returns setof public.audit_log language plpgsql security definer stable set search_path = '' as $$
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  return query select audit.* from public.audit_log audit order by audit.created_at desc limit 100;
end
$$;

create or replace function public.get_support_legal_settings()
returns public.legal_settings language plpgsql security definer stable set search_path = '' as $$
declare v_session public.support_sessions; v_settings public.legal_settings;
begin
  if not (select private.is_platform_admin()) then raise exception 'PLATFORM_ADMIN_REQUIRED' using errcode='42501'; end if;
  select session.* into v_session from public.support_sessions session
    where session.admin_user_id=(select auth.uid()) and session.started_at<=now()
      and session.expires_at>now() and session.ended_at is null
    order by session.started_at desc limit 1;
  if not found then raise exception 'SUPPORT_SESSION_REQUIRED' using errcode='42501'; end if;
  select settings.* into v_settings from public.legal_settings settings where settings.restaurant_id=v_session.restaurant_id;
  if not found then raise exception 'LEGAL_SETTINGS_NOT_FOUND' using errcode='P0002'; end if;
  return v_settings;
end $$;

grant usage on schema public,private,auth to admin_audit_executor;
grant execute on function auth.uid(),auth.jwt() to admin_audit_executor;
grant select on public.restaurants,public.support_sessions,public.feature_flags,public.phone_numbers,
  public.calls,public.audit_log,public.legal_settings to admin_audit_executor;
grant update(recording_path) on public.calls to admin_audit_executor;
grant insert,update on public.support_sessions,public.feature_flags to admin_audit_executor;
grant update(kill_switch) on public.phone_numbers to admin_audit_executor;
grant insert on public.audit_log to admin_audit_executor;

-- PostgreSQL requires the new function owner to have CREATE on the schema and
-- the migrator to be able to SET ROLE during ownership transfer:
-- https://www.postgresql.org/docs/current/sql-alterfunction.html
grant create on schema public to admin_audit_executor;
-- Postgres 17.6 (local Supabase image) segfaults on `GRANT ... TO current_user`; name the role explicitly.
do $$ begin execute format('grant admin_audit_executor to %I', current_user); end $$;
alter function public.start_support_session(uuid,text) owner to admin_audit_executor;
alter function public.end_support_session(uuid) owner to admin_audit_executor;
alter function public.set_feature_flag(text,uuid,boolean) owner to admin_audit_executor;
alter function public.set_phone_kill_switch(uuid,boolean,text) owner to admin_audit_executor;
alter function public.get_admin_recording_path(uuid) owner to admin_audit_executor;
alter function public.list_admin_restaurant_usage() owner to admin_audit_executor;
alter function public.list_admin_audit_logs() owner to admin_audit_executor;
alter function public.get_support_legal_settings() owner to admin_audit_executor;
revoke create on schema public from admin_audit_executor;
do $$ begin execute format('revoke admin_audit_executor from %I', current_user); end $$;

revoke all on function public.start_support_session(uuid,text) from public,anon,service_role;
revoke all on function public.end_support_session(uuid) from public,anon,service_role;
revoke all on function public.set_feature_flag(text,uuid,boolean) from public,anon,service_role;
revoke all on function public.set_phone_kill_switch(uuid,boolean,text) from public,anon,service_role;
revoke all on function public.get_admin_recording_path(uuid) from public,anon,service_role;
revoke all on function public.list_admin_restaurant_usage() from public,anon,service_role;
revoke all on function public.list_admin_audit_logs() from public,anon,service_role;
revoke all on function public.get_support_legal_settings() from public,anon,service_role;
grant execute on function public.start_support_session(uuid,text) to authenticated;
grant execute on function public.end_support_session(uuid) to authenticated;
grant execute on function public.set_feature_flag(text,uuid,boolean) to authenticated;
grant execute on function public.set_phone_kill_switch(uuid,boolean,text) to authenticated;
grant execute on function public.get_admin_recording_path(uuid) to authenticated;
grant execute on function public.list_admin_restaurant_usage() to authenticated;
grant execute on function public.list_admin_audit_logs() to authenticated;
grant execute on function public.get_support_legal_settings() to authenticated;
