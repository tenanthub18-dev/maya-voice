-- Browser provider estimates are USD review data, not business telephone usage.
-- Replace as the existing owner; Supabase postgres is not a superuser.
-- All temporary grants and the function/ACL change are one transaction.
-- CREATE OR REPLACE preserves the existing owner:
-- https://www.postgresql.org/docs/current/sql-createfunction.html
begin;

do $$
begin
  perform set_config('app.browser_usage_migrator', current_user, true);
  perform set_config('app.browser_usage_had_create',
    has_schema_privilege('admin_audit_executor', 'public', 'CREATE')::text, true);
  perform set_config('app.browser_usage_could_set',
    pg_has_role(current_user, 'admin_audit_executor', 'SET')::text, true);
  -- PG17 tracks membership by grantor. Preserve an existing grant's options,
  -- including ADMIN-only membership that does not yet permit SET ROLE.
  perform set_config('app.browser_usage_had_own_grant', exists (
    select 1 from pg_auth_members
    where roleid = 'admin_audit_executor'::regrole
      and member = current_user::regrole and grantor = current_user::regrole
  )::text, true);
  if not current_setting('app.browser_usage_could_set')::boolean then
    -- Explicit identifier avoids Supabase PG17's GRANT ... TO CURRENT_USER bug.
    -- https://www.postgresql.org/docs/17/sql-grant.html
    execute format('grant admin_audit_executor to %I with set true', current_user);
  end if;
  if not current_setting('app.browser_usage_had_create')::boolean then
    grant create on schema public to admin_audit_executor;
  end if;
end
$$;

set local role admin_audit_executor;

create or replace function public.list_admin_restaurant_usage()
returns table(restaurant_id uuid,name text,status text,calls bigint,minutes numeric,cost_micros bigint)
language sql security definer stable set search_path = '' as $$
  select restaurant.id,restaurant.name,restaurant.status,
    coalesce(stats.calls,0),coalesce(stats.minutes,0),coalesce(stats.cost_micros,0)
  from public.restaurants restaurant
  left join lateral (
    select count(*) calls,coalesce(sum(call.billable_seconds),0)::numeric/60 minutes,
      coalesce(sum((select coalesce(sum(cost.value::bigint),0) from jsonb_each_text(call.cost_micros) cost)),0)::bigint cost_micros
    from public.calls call where call.restaurant_id=restaurant.id and call.source <> 'browser'
  ) stats on true
  where (select private.is_platform_admin())
  order by restaurant.name,restaurant.id
$$;

-- Revoke as the owner BEFORE giving up its role; the original migration's
-- post-membership revokes did not remove these leaked execution grants.
revoke execute on function public.list_admin_restaurant_usage() from public,anon,service_role;
grant execute on function public.list_admin_restaurant_usage() to authenticated;

-- Restore the actual invoking role, including when invoked through SET ROLE.
select set_config('role', current_setting('app.browser_usage_migrator'), true);

do $$
begin
  if not current_setting('app.browser_usage_had_create')::boolean then
    revoke create on schema public from admin_audit_executor;
  end if;
  if not current_setting('app.browser_usage_could_set')::boolean then
    -- Remove only what this grantor added. Other membership grants/options stay.
    -- https://www.postgresql.org/docs/17/sql-revoke.html
    if current_setting('app.browser_usage_had_own_grant')::boolean then
      execute format('revoke set option for admin_audit_executor from %I', current_user);
    else
      execute format('revoke admin_audit_executor from %I', current_user);
    end if;
  end if;
end
$$;

commit;
