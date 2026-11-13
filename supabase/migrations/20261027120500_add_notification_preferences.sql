-- Per-user notification controls and digest aggregation.
create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  locale text not null default 'en' check (locale in ('en','fr')),
  message_taken boolean not null default true,
  missed_transfer boolean not null default true,
  flagged_call boolean not null default true,
  low_balance boolean not null default true,
  daily_digest boolean not null default true,
  last_digest_date date,
  unique(user_id, organization_id)
);

create trigger set_notification_preferences_updated_at
before update on public.notification_preferences
for each row execute function private.set_updated_at();

alter table public.notification_preferences enable row level security;
create policy notification_preferences_select on public.notification_preferences
for select to authenticated using(user_id = (select auth.uid()));
create policy notification_preferences_update on public.notification_preferences
for update to authenticated using(user_id = (select auth.uid()))
with check(user_id = (select auth.uid()));
create policy notification_preferences_insert on public.notification_preferences
for insert to authenticated with check(
  user_id = (select auth.uid())
  and organization_id in(select private.user_organization_ids())
);

grant select, insert, update on public.notification_preferences to authenticated;
grant all on public.notification_preferences to service_role;

create function public.daily_digest_candidates(p_day date)
returns table(
  id uuid, email text, locale text, restaurant_name text,
  calls bigint, bookings bigint, orders bigint, messages bigint, flagged bigint
)
language sql
security definer
set search_path = ''
as $$
  select
    np.id,
    np.email,
    np.locale,
    min(r.name) as restaurant_name,
    count(distinct c.id) as calls,
    count(distinct b.id) as bookings,
    count(distinct o.id) as orders,
    count(distinct m.id) as messages,
    count(distinct c.id) filter (where cardinality(c.qa_flags) > 0) as flagged
  from public.notification_preferences np
  join public.restaurants r on r.organization_id = np.organization_id
  left join public.calls c on c.restaurant_id = r.id
    and c.started_at >= (p_day::timestamp at time zone r.timezone)
    and c.started_at < ((p_day + 1)::timestamp at time zone r.timezone)
  left join public.bookings b on b.restaurant_id = r.id
    and b.created_at >= (p_day::timestamp at time zone r.timezone)
    and b.created_at < ((p_day + 1)::timestamp at time zone r.timezone)
  left join public.orders o on o.restaurant_id = r.id
    and o.created_at >= (p_day::timestamp at time zone r.timezone)
    and o.created_at < ((p_day + 1)::timestamp at time zone r.timezone)
  left join public.messages m on m.restaurant_id = r.id
    and m.created_at >= (p_day::timestamp at time zone r.timezone)
    and m.created_at < ((p_day + 1)::timestamp at time zone r.timezone)
  where np.daily_digest
    and np.last_digest_date is distinct from p_day
  group by np.id, np.email, np.locale;
$$;

revoke all on function public.daily_digest_candidates(date) from public, anon, authenticated;
grant execute on function public.daily_digest_candidates(date) to service_role;
