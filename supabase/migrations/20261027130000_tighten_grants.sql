-- Column-level privileges: https://www.postgresql.org/docs/current/sql-grant.html
revoke update on public.organizations from authenticated;
grant update(name, spend_cap_cents) on public.organizations to authenticated;

revoke insert, update, delete on public.phone_numbers from authenticated;
drop policy if exists phone_numbers_owner_write on public.phone_numbers;

revoke insert, update, delete on public.sms_optouts from authenticated;
drop policy if exists sms_optouts_owner_write on public.sms_optouts;

revoke execute on function public.create_booking(uuid,text,text,integer,timestamptz,text) from authenticated;
drop function public.create_booking(uuid,text,text,integer,timestamptz,text);

alter table public.bookings drop constraint bookings_source_check;
update public.bookings set source = 'phone' where source = 'call';
alter table public.bookings add constraint bookings_source_check
  check (source in ('owner','staff','phone','web'));

create function public.create_booking(
  p_restaurant_id uuid,
  p_name text,
  p_phone_e164 text,
  p_party_size integer,
  p_starts_at timestamptz,
  p_notes text default '',
  p_source text default 'owner'
)
returns public.bookings language plpgsql set search_path = '' as $$
declare v_booking public.bookings;
begin
  insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,notes,source)
  values(p_restaurant_id,p_name,p_phone_e164,p_party_size,p_starts_at,'confirmed',coalesce(p_notes,''),p_source)
  returning * into v_booking;
  return v_booking;
end $$;
revoke execute on function public.create_booking(uuid,text,text,integer,timestamptz,text,text) from public;
grant execute on function public.create_booking(uuid,text,text,integer,timestamptz,text,text) to authenticated;
