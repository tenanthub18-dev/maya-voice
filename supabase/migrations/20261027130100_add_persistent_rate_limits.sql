create table private.rate_limit_windows (
  scope text not null,
  key text not null,
  request_count integer not null check (request_count > 0),
  reset_at timestamptz not null,
  primary key (scope, key)
);

create or replace function public.consume_rate_limit(
  p_scope text,
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_window private.rate_limit_windows%rowtype;
  now_at timestamptz := clock_timestamp();
begin
  if length(p_scope) = 0 or length(p_key) = 0 or p_limit <= 0 or p_limit >= 2147483647 or p_window_seconds <= 0 then
    raise exception 'INVALID_RATE_LIMIT';
  end if;

  insert into private.rate_limit_windows(scope, key, request_count, reset_at)
  values (p_scope, p_key, 1, now_at + make_interval(secs => p_window_seconds))
  on conflict (scope, key) do update set
    request_count = case
      when private.rate_limit_windows.reset_at <= now_at then 1
      when private.rate_limit_windows.request_count >= p_limit + 1 then private.rate_limit_windows.request_count
      else private.rate_limit_windows.request_count + 1
    end,
    reset_at = case
      when private.rate_limit_windows.reset_at <= now_at then now_at + make_interval(secs => p_window_seconds)
      else private.rate_limit_windows.reset_at
    end
  returning * into current_window;

  allowed := current_window.request_count <= p_limit;
  retry_after_seconds := case when allowed then 0 else greatest(
    1,
    ceil(extract(epoch from current_window.reset_at - now_at))::integer
  ) end;
  return next;
end;
$$;

revoke all on function public.consume_rate_limit(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text,text,integer,integer) to service_role;

create or replace function public.get_authorized_recording_path(
  p_call_id uuid,
  p_organization_id uuid
)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select c.recording_path
  from public.calls c
  join public.restaurants r on r.id = c.restaurant_id
  where c.id = p_call_id
    and r.organization_id = p_organization_id
    and c.recording_path is not null
$$;

revoke all on function public.get_authorized_recording_path(uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_authorized_recording_path(uuid,uuid) to service_role;
