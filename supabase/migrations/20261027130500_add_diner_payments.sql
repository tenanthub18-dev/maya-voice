alter table public.restaurants
  add column stripe_connected_account_id text
    check (stripe_connected_account_id is null or stripe_connected_account_id ~ '^acct_[A-Za-z0-9]+$'),
  add column booking_deposit_cents integer not null default 0
    check (booking_deposit_cents >= 0);

create unique index restaurants_stripe_connected_account_id_idx
  on public.restaurants(stripe_connected_account_id)
  where stripe_connected_account_id is not null;

-- Keep historical account ownership so a payment completed after a local
-- disconnect still reconciles to the restaurant that issued the link.
create table public.restaurant_stripe_accounts (
  account_id text primary key check (account_id ~ '^acct_[A-Za-z0-9]+$'),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  connected_at timestamptz not null default now(),
  disconnected_at timestamptz
);
alter table public.restaurant_stripe_accounts enable row level security;
revoke all on public.restaurant_stripe_accounts from public,anon,authenticated;

insert into public.restaurant_stripe_accounts(account_id,restaurant_id)
select stripe_connected_account_id,id from public.restaurants
where stripe_connected_account_id is not null;

create function private.track_restaurant_stripe_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.stripe_connected_account_id is not distinct from new.stripe_connected_account_id then
    return new;
  end if;
  if old.stripe_connected_account_id is not null then
    update public.restaurant_stripe_accounts set disconnected_at=now()
    where account_id=old.stripe_connected_account_id and restaurant_id=old.id;
  end if;
  if new.stripe_connected_account_id is not null then
    if exists(
      select 1 from public.restaurant_stripe_accounts
      where account_id=new.stripe_connected_account_id and restaurant_id<>new.id
    ) then
      raise exception 'Stripe connected account already belongs to another restaurant';
    end if;
    insert into public.restaurant_stripe_accounts(account_id,restaurant_id,disconnected_at)
    values (new.stripe_connected_account_id,new.id,null)
    on conflict(account_id) do update set disconnected_at=null;
  end if;
  return new;
end
$$;

revoke all on function private.track_restaurant_stripe_account() from public,anon,authenticated;
create trigger restaurants_track_stripe_account
before update of stripe_connected_account_id on public.restaurants
for each row execute function private.track_restaurant_stripe_account();

alter table public.bookings
  add column paid_status text not null default 'unpaid'
    check (paid_status in ('unpaid','paid','refunded'));

alter table public.orders alter column paid_status set default 'unpaid';

-- Preserve owner-managed restaurant and operational fields while keeping the
-- connected Stripe account server-only.
revoke update on public.restaurants from authenticated;
revoke insert on public.restaurants from authenticated;
grant insert(organization_id,name,address,province,timezone,primary_language,
  enabled_languages,transfer_phone,transfer_hours,status,booking_deposit_cents)
  on public.restaurants to authenticated;
grant update(name,address,province,timezone,primary_language,enabled_languages,
  transfer_phone,transfer_hours,status,booking_deposit_cents)
  on public.restaurants to authenticated;

-- A Stripe-paid state is evidence from a verified webhook, not an owner-editable
-- field. Staff can continue editing the existing booking/order operational fields.
revoke update on public.bookings from authenticated;
revoke insert on public.bookings from authenticated;
grant insert(restaurant_id,call_id,name,phone_e164,party_size,starts_at,status,notes,source)
  on public.bookings to authenticated;
grant update(name,phone_e164,party_size,starts_at,status,notes,source)
  on public.bookings to authenticated;
revoke update on public.orders from authenticated;
revoke insert on public.orders from authenticated;
grant insert(restaurant_id,call_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,status)
  on public.orders to authenticated;
grant update(name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,status)
  on public.orders to authenticated;

-- Owners need only the effective flag rows for their own restaurant; the
-- platform-admin write policies from 035 remain unchanged.
create policy feature_flags_restaurant_member_select on public.feature_flags
for select to authenticated using (
  restaurant_id is null
  or restaurant_id in (select private.user_restaurant_ids())
);

-- Worker and internal web routes use service-role reads. Mutating feature flags
-- remains restricted to the audited admin executor.
grant select on public.feature_flags to service_role;
grant select(id,organization_id,stripe_connected_account_id,booking_deposit_cents)
  on public.restaurants to service_role;
grant update(stripe_connected_account_id) on public.restaurants to service_role;
grant select(id,restaurant_id,total_cents,paid_status,phone) on public.orders to service_role;
grant select(id,restaurant_id,paid_status,phone_e164) on public.bookings to service_role;

create function public.is_diner_payments_enabled(p_restaurant_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select coalesce(
    (select flag.enabled from public.feature_flags flag
      where flag.key='diner_payments' and flag.restaurant_id=p_restaurant_id),
    (select flag.enabled from public.feature_flags flag
      where flag.key='diner_payments' and flag.restaurant_id is null),
    false
  )
$$;

create function public.apply_connected_payment_event(
  p_connected_account_id text,
  p_target_kind text,
  p_target_id uuid
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_restaurant_id uuid;
begin
  select mapping.restaurant_id into v_restaurant_id
  from public.restaurant_stripe_accounts mapping
  where mapping.account_id=p_connected_account_id;
  if not found then return 'not_found'; end if;

  if p_target_kind='order' then
    update public.orders set paid_status='paid'
    where id=p_target_id and restaurant_id=v_restaurant_id and paid_status<>'paid';
    if found then return 'applied'; end if;
    if exists(select 1 from public.orders where id=p_target_id and restaurant_id=v_restaurant_id and paid_status='paid') then
      return 'stale';
    end if;
    return 'not_found';
  elsif p_target_kind='booking' then
    update public.bookings set paid_status='paid'
    where id=p_target_id and restaurant_id=v_restaurant_id and paid_status<>'paid';
    if found then return 'applied'; end if;
    if exists(select 1 from public.bookings where id=p_target_id and restaurant_id=v_restaurant_id and paid_status='paid') then
      return 'stale';
    end if;
    return 'not_found';
  end if;
  return 'not_found';
end
$$;

revoke all on function public.is_diner_payments_enabled(uuid) from public,anon,authenticated;
revoke all on function public.apply_connected_payment_event(text,text,uuid) from public,anon,authenticated;
grant execute on function public.is_diner_payments_enabled(uuid) to service_role;
grant execute on function public.apply_connected_payment_event(text,text,uuid) to service_role;
