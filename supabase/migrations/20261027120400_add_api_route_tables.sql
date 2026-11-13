-- Route persistence follows Supabase table and RLS guidance:
-- https://supabase.com/docs/guides/database/tables
create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  requested_by uuid references auth.users(id) on delete set null,
  source_url text not null check (source_url ~ '^https?://'),
  provider_job_id text,
  status text not null default 'queued' check (status in ('queued','processing','extracting','completed','failed')),
  extraction_started_at timestamptz,
  result jsonb,
  error text,
  check ((status = 'failed' and error is not null) or status <> 'failed')
);

create table public.processed_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  provider text not null check (provider in ('stripe','telnyx-sms','resend')),
  event_id text not null,
  status text not null check (status in ('processing','completed','failed')),
  claimed_at timestamptz not null default now(),
  processed_at timestamptz,
  error text,
  unique(provider,event_id)
);

create table public.import_review_rows (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  job_id uuid not null references public.import_jobs(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  kind text not null check (kind in ('menu','hours','faq')),
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','accepted','rejected'))
);

create trigger set_import_jobs_updated_at before update on public.import_jobs
for each row execute function private.set_updated_at();
create trigger set_processed_events_updated_at before update on public.processed_events
for each row execute function private.set_updated_at();
create trigger set_import_review_rows_updated_at before update on public.import_review_rows
for each row execute function private.set_updated_at();

create index import_jobs_organization_id_idx on public.import_jobs(organization_id);
create index import_jobs_restaurant_id_idx on public.import_jobs(restaurant_id);
create index import_jobs_status_idx on public.import_jobs(status);
create index import_review_rows_job_id_idx on public.import_review_rows(job_id);
create index import_review_rows_restaurant_id_idx on public.import_review_rows(restaurant_id);
create index processed_events_status_idx on public.processed_events(provider,status);

alter table public.import_jobs enable row level security;
alter table public.processed_events enable row level security;
alter table public.import_review_rows enable row level security;

grant select on public.import_jobs to authenticated;
grant select,update on public.import_review_rows to authenticated;
create policy import_jobs_select on public.import_jobs for select to authenticated
using (organization_id in (select private.user_organization_ids()));
create policy import_review_rows_select on public.import_review_rows for select to authenticated
using (restaurant_id in (select private.user_restaurant_ids()));
create policy import_review_rows_owner_update on public.import_review_rows for update to authenticated
using (private.is_restaurant_owner(restaurant_id))
with check (private.is_restaurant_owner(restaurant_id));

alter table public.sms_log add column provider_message_id text;
alter table public.sms_log add column last_event_at timestamptz;
alter table public.sms_log add column delivery_error jsonb;
create unique index sms_log_provider_message_id_idx on public.sms_log(provider_message_id)
where provider_message_id is not null;

alter table public.phone_numbers drop constraint phone_numbers_status_check;
alter table public.phone_numbers add constraint phone_numbers_status_check
check (status in ('pending','active','releasing','released'));

alter table public.organizations
  add column stripe_subscription_id text unique,
  add column stripe_subscription_status text,
  add column stripe_checkout_event_created_at timestamptz,
  add column stripe_checkout_event_id text,
  add column stripe_subscription_event_created_at timestamptz,
  add column stripe_subscription_event_id text,
  add column stripe_invoice_event_created_at timestamptz,
  add column stripe_invoice_event_id text,
  add column stripe_billing_alert_event_created_at timestamptz,
  add column stripe_billing_alert_event_id text,
  add column last_invoice_id text,
  add column last_invoice_status text;

-- Atomic retry claim: failed deliveries may be retried, while processing and
-- completed deliveries remain duplicates.
create function public.claim_processed_event(p_provider text, p_event_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  insert into public.processed_events(provider,event_id,status)
  values(p_provider,p_event_id,'processing')
  on conflict(provider,event_id) do update
    set status='processing', error=null, processed_at=null, claimed_at=now(), updated_at=now()
    where public.processed_events.status='failed'
      or (public.processed_events.status='processing'
        and public.processed_events.claimed_at < now()-interval '5 minutes');
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create function public.claim_import_extraction(p_job_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  update public.import_jobs set status='extracting', extraction_started_at=now(), updated_at=now()
  where id=p_job_id and (
    status='processing'
    or (status='extracting' and extraction_started_at < now()-interval '5 minutes')
  );
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create function public.replace_import_review_rows(
  p_job_id uuid,
  p_restaurant_id uuid,
  p_rows jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'review rows must be an array'; end if;
  delete from public.import_review_rows where job_id=p_job_id;
  insert into public.import_review_rows(job_id,restaurant_id,kind,payload,status)
  select p_job_id,p_restaurant_id,row->>'kind',row->'payload',coalesce(row->>'status','pending')
  from jsonb_array_elements(p_rows) as row;
  return true;
end;
$$;

-- Stripe does not guarantee webhook ordering. Each event domain has an
-- independent timestamp so an older invoice cannot block a newer subscription
-- update, and an older event within a domain cannot roll state backward.
-- https://docs.stripe.com/webhooks#event-ordering
create function public.apply_stripe_billing_event(
  p_customer_id text,
  p_restaurant_id uuid,
  p_category text,
  p_event_created_at timestamptz,
  p_value jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
declare incoming_event_id text;
begin
  if p_category not in ('checkout','subscription','invoice','billing_alert') then
    raise exception 'invalid Stripe event category';
  end if;
  incoming_event_id := p_value->>(case p_category
    when 'checkout' then 'stripe_checkout_event_id'
    when 'subscription' then 'stripe_subscription_event_id'
    when 'invoice' then 'stripe_invoice_event_id'
    when 'billing_alert' then 'stripe_billing_alert_event_id'
  end);
  if incoming_event_id is null then raise exception 'Stripe event id is required'; end if;

  update public.organizations as organization set
    stripe_customer_id = case when p_value ? 'stripe_customer_id'
      then p_value->>'stripe_customer_id' else organization.stripe_customer_id end,
    stripe_subscription_id = case when p_value ? 'stripe_subscription_id'
      then p_value->>'stripe_subscription_id' else organization.stripe_subscription_id end,
    stripe_subscription_status = case when p_value ? 'stripe_subscription_status'
      then p_value->>'stripe_subscription_status' else organization.stripe_subscription_status end,
    last_invoice_id = case when p_value ? 'last_invoice_id'
      then p_value->>'last_invoice_id' else organization.last_invoice_id end,
    last_invoice_status = case when p_value ? 'last_invoice_status'
      then p_value->>'last_invoice_status' else organization.last_invoice_status end,
    stripe_checkout_event_created_at = case when p_category='checkout'
      then p_event_created_at else organization.stripe_checkout_event_created_at end,
    stripe_checkout_event_id = case when p_category='checkout'
      then incoming_event_id else organization.stripe_checkout_event_id end,
    stripe_subscription_event_created_at = case when p_category='subscription'
      then p_event_created_at else organization.stripe_subscription_event_created_at end,
    stripe_subscription_event_id = case when p_category='subscription'
      then incoming_event_id else organization.stripe_subscription_event_id end,
    stripe_invoice_event_created_at = case when p_category='invoice'
      then p_event_created_at else organization.stripe_invoice_event_created_at end,
    stripe_invoice_event_id = case when p_category='invoice'
      then incoming_event_id else organization.stripe_invoice_event_id end,
    stripe_billing_alert_event_created_at = case when p_category='billing_alert'
      then p_event_created_at else organization.stripe_billing_alert_event_created_at end,
    stripe_billing_alert_event_id = case when p_category='billing_alert'
      then incoming_event_id else organization.stripe_billing_alert_event_id end
  where (
    (p_customer_id is not null and organization.stripe_customer_id=p_customer_id)
    or (p_restaurant_id is not null and organization.id=(
      select restaurant.organization_id from public.restaurants as restaurant
      where restaurant.id=p_restaurant_id
    ))
  ) and case p_category
    when 'checkout' then organization.stripe_checkout_event_created_at is null
      or organization.stripe_checkout_event_created_at < p_event_created_at
      or (organization.stripe_checkout_event_created_at = p_event_created_at
        and coalesce(organization.stripe_checkout_event_id,'') < incoming_event_id)
    when 'subscription' then organization.stripe_subscription_event_created_at is null
      or organization.stripe_subscription_event_created_at < p_event_created_at
      or (organization.stripe_subscription_event_created_at = p_event_created_at
        and coalesce(organization.stripe_subscription_event_id,'') < incoming_event_id)
    when 'invoice' then organization.stripe_invoice_event_created_at is null
      or organization.stripe_invoice_event_created_at < p_event_created_at
      or (organization.stripe_invoice_event_created_at = p_event_created_at
        and coalesce(organization.stripe_invoice_event_id,'') < incoming_event_id)
    when 'billing_alert' then organization.stripe_billing_alert_event_created_at is null
      or organization.stripe_billing_alert_event_created_at < p_event_created_at
      or (organization.stripe_billing_alert_event_created_at = p_event_created_at
        and coalesce(organization.stripe_billing_alert_event_id,'') < incoming_event_id)
  end;
  get diagnostics affected = row_count;
  if affected = 1 then return 'applied'; end if;
  if exists(
    select 1 from public.organizations as organization
    where (p_customer_id is not null and organization.stripe_customer_id=p_customer_id)
      or (p_restaurant_id is not null and organization.id=(
        select restaurant.organization_id from public.restaurants as restaurant
        where restaurant.id=p_restaurant_id
      ))
  ) then return 'stale'; end if;
  return 'not_found';
end;
$$;

create function public.finalize_phone_release(
  p_phone_id uuid,
  p_actor_id uuid,
  p_target text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.phone_numbers set status='released' where id=p_phone_id;
  if not found then raise exception 'phone number not found'; end if;
  insert into public.audit_log(actor_id,action,target,reason)
  values(p_actor_id,'phone_number.release',p_target,p_reason);
  return true;
end;
$$;

-- Delivery callbacks can arrive out of order. Timestamp wins first; at an
-- equal timestamp a finalized state wins over the intermediate sent state.
create function public.apply_sms_delivery_event(
  p_provider_message_id text,
  p_status text,
  p_event_at timestamptz,
  p_delivery_error jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare affected integer;
begin
  if p_status not in ('sent','delivered','failed') then
    raise exception 'invalid SMS delivery status';
  end if;
  update public.sms_log as log set
    status=p_status,
    last_event_at=coalesce(p_event_at,log.last_event_at),
    delivery_error=p_delivery_error
  where log.provider_message_id=p_provider_message_id
    and (
      (log.last_event_at is null and p_event_at is null)
      or (p_event_at is not null and (
        log.last_event_at is null
        or p_event_at > log.last_event_at
        or (p_event_at = log.last_event_at and
          case p_status when 'sent' then 1 else 2 end >=
          case log.status when 'sent' then 1 when 'delivered' then 2 when 'failed' then 2 else 0 end)
      ))
    );
  get diagnostics affected = row_count;
  if affected = 1 then return 'applied'; end if;
  if exists(select 1 from public.sms_log where provider_message_id=p_provider_message_id) then
    return 'stale';
  end if;
  return 'not_found';
end;
$$;

revoke all on function public.claim_processed_event(text,text) from public;
revoke all on function public.claim_import_extraction(uuid) from public;
revoke all on function public.replace_import_review_rows(uuid,uuid,jsonb) from public;
revoke all on function public.apply_stripe_billing_event(text,uuid,text,timestamptz,jsonb) from public;
revoke all on function public.apply_sms_delivery_event(text,text,timestamptz,jsonb) from public;
revoke all on function public.finalize_phone_release(uuid,uuid,text,text) from public;
grant execute on function public.claim_processed_event(text,text) to service_role;
grant execute on function public.claim_import_extraction(uuid) to service_role;
grant execute on function public.replace_import_review_rows(uuid,uuid,jsonb) to service_role;
grant execute on function public.apply_stripe_billing_event(text,uuid,text,timestamptz,jsonb) to service_role;
grant execute on function public.apply_sms_delivery_event(text,text,timestamptz,jsonb) to service_role;
grant execute on function public.finalize_phone_release(uuid,uuid,text,text) to service_role;
