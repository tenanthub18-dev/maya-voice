create table public.usage_alerts_sent (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  threshold text not null check (length(trim(threshold)) > 0),
  unique(organization_id, period, threshold)
);

create trigger set_usage_alerts_sent_updated_at
before update on public.usage_alerts_sent
for each row execute function private.set_updated_at();

alter table public.usage_alerts_sent enable row level security;
revoke all on public.usage_alerts_sent from public, anon, authenticated;
grant all on public.usage_alerts_sent to service_role;

alter table public.usage_ledger
  add column reported_seconds integer not null default 0,
  add column reporting_identifier text,
  add column reporting_seconds integer,
  add constraint usage_ledger_reporting_bounds check (
    reported_seconds >= 0
    and reported_seconds <= seconds
    and ((reporting_identifier is null and reporting_seconds is null)
      or (reporting_identifier is not null and reporting_seconds > reported_seconds and reporting_seconds <= seconds))
  );

create or replace function public.claim_usage_report(
  p_organization_id uuid,
  p_period text,
  p_target_seconds integer,
  p_identifier text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ledger public.usage_ledger%rowtype;
begin
  select * into ledger
  from public.usage_ledger
  where organization_id = p_organization_id and period = p_period
  for update;
  if not found then raise exception 'Usage ledger was not found'; end if;
  if ledger.reporting_identifier is null then
    if ledger.seconds <> p_target_seconds or p_target_seconds <= ledger.reported_seconds then
      raise exception 'Usage ledger changed before the report batch was claimed';
    end if;
    update public.usage_ledger set
      reporting_identifier = p_identifier,
      reporting_seconds = p_target_seconds,
      stripe_reported = false
    where id = ledger.id
    returning * into ledger;
  end if;
  return jsonb_build_object(
    'identifier', ledger.reporting_identifier,
    'targetSeconds', ledger.reporting_seconds,
    'reportedSeconds', ledger.reported_seconds
  );
end;
$$;

create or replace function public.complete_usage_report(
  p_organization_id uuid,
  p_period text,
  p_identifier text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  ledger public.usage_ledger%rowtype;
begin
  select * into ledger
  from public.usage_ledger
  where organization_id = p_organization_id and period = p_period
  for update;
  if not found or ledger.reporting_identifier is distinct from p_identifier then
    raise exception 'Usage report batch does not match the staged batch';
  end if;
  update public.usage_ledger set
    reported_seconds = ledger.reporting_seconds,
    reporting_identifier = null,
    reporting_seconds = null,
    stripe_reported = (ledger.seconds = ledger.reporting_seconds)
  where id = ledger.id
  returning * into ledger;
  return jsonb_build_object(
    'seconds', ledger.seconds,
    'reportedSeconds', ledger.reported_seconds,
    'stripeReported', ledger.stripe_reported
  );
end;
$$;

revoke all on function public.claim_usage_report(uuid,text,integer,text) from public, anon, authenticated;
revoke all on function public.complete_usage_report(uuid,text,text) from public, anon, authenticated;
grant execute on function public.claim_usage_report(uuid,text,integer,text) to service_role;
grant execute on function public.complete_usage_report(uuid,text,text) to service_role;
