-- Add browser logs without giving clients write access or changing existing RLS.
-- https://supabase.com/docs/guides/database/tables
-- https://www.postgresql.org/docs/current/ddl-constraints.html
begin;

alter table public.calls
  add column source text not null default 'phone',
  add column usage jsonb not null default '{}'::jsonb,
  alter column telnyx_call_id drop not null,
  alter column from_e164_hash drop not null,
  alter column from_last4 drop not null,
  add constraint calls_source_check check (source in ('phone', 'browser')),
  add constraint calls_source_identity_check check (
    (source = 'phone' and telnyx_call_id is not null
      and from_e164_hash is not null and from_last4 is not null)
    or (source = 'browser' and telnyx_call_id is null
      and from_e164_hash is null and from_last4 is null and billable_seconds = 0)
  ),
  add constraint calls_usage_object_check check (jsonb_typeof(usage) = 'object');

-- The existing unique(telnyx_call_id), last-four format check, grants and
-- restaurant-scoped SELECT policies also protect these new rows/columns.
commit;
