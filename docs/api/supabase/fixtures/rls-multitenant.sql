-- Pattern assembled from docs. Sources:
--  https://supabase.com/docs/guides/database/postgres/row-level-security  (select-wrapped auth.uid(), TO authenticated, index on user_id, security definer helper in private schema, 42P17 recursion warning)
-- The memberships/restaurant_id schema itself is OUR ADAPTATION (UNVERIFIED as a docs example); structure mirrors docs' team_members + private.user_list_ids().

create table public.memberships (
  restaurant_id uuid not null references public.restaurants (id),
  user_id uuid not null references auth.users (id),
  role text not null default 'staff',
  primary key (restaurant_id, user_id)
);
create index memberships_user_id_idx on public.memberships using btree (user_id);
alter table public.memberships enable row level security;

create schema if not exists private;
create function private.user_restaurant_ids()
returns setof uuid
language sql
security definer
set search_path = ''
stable
as $$
  select restaurant_id from public.memberships
  where user_id = (select auth.uid())
$$;
revoke execute on function private.user_restaurant_ids() from public;
grant usage on schema private to authenticated;
grant execute on function private.user_restaurant_ids() to authenticated;

create policy "members read own memberships" on public.memberships for select
to authenticated using ( user_id = (select auth.uid()) );

-- Example tenant table (calls)
alter table public.calls enable row level security;
revoke all on table public.calls from anon, authenticated;
grant select on table public.calls to authenticated;
create policy "members read calls" on public.calls for select
to authenticated
using ( restaurant_id in (select private.user_restaurant_ids()) );
create index calls_restaurant_id_idx on public.calls using btree (restaurant_id);
