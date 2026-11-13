create index if not exists bookings_availability_idx
on public.bookings(restaurant_id, starts_at)
where status in ('confirmed', 'seated');

create or replace function public.check_availability(
  p_restaurant_id uuid,
  p_starts_at timestamptz,
  p_party_size integer
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((
    select
      p_party_size > 0
      and p_party_size <= config.max_party
      and coalesce(sum(booking.party_size) filter (
        where booking.status in ('confirmed', 'seated')
          and booking.starts_at < p_starts_at + make_interval(mins => config.seating_minutes)
          and booking.starts_at + make_interval(mins => config.seating_minutes) > p_starts_at
      ), 0) + p_party_size <= config.covers_per_slot
    from public.slots_config config
    left join public.bookings booking on booking.restaurant_id = config.restaurant_id
    where config.restaurant_id = p_restaurant_id
    group by config.max_party, config.covers_per_slot, config.seating_minutes
  ), false)
$$;

revoke execute on function public.check_availability(uuid,timestamptz,integer) from public;
grant execute on function public.check_availability(uuid,timestamptz,integer) to authenticated, service_role;
