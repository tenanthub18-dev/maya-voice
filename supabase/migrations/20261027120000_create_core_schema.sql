-- PostgreSQL schema and functions: https://supabase.com/docs/guides/database/tables
create schema if not exists private;

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null check (length(trim(name)) > 0),
  stripe_customer_id text unique,
  plan text not null check (plan in ('starter', 'growth')),
  spend_cap_cents integer not null check (spend_cap_cents >= 0)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('owner', 'staff')),
  unique (organization_id, user_id)
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null check (length(trim(name)) > 0), address text not null, province text not null,
  timezone text not null, primary_language text not null check (primary_language in ('en','fr-CA','ur','hi','pa')),
  enabled_languages text[] not null check (cardinality(enabled_languages) > 0 and enabled_languages <@ array['en','fr-CA','ur','hi','pa']::text[] and primary_language = any(enabled_languages)),
  transfer_phone text, transfer_hours jsonb not null default '{}'::jsonb,
  status text not null check (status in ('draft','live','paused'))
);

create table public.hours (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6), open_time time not null, close_time time not null,
  check (open_time < close_time), unique (restaurant_id, weekday)
);
create table public.hours_overrides (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade, date date not null,
  open_time time, close_time time,
  check ((open_time is null and close_time is null) or (open_time is not null and close_time is not null and open_time < close_time)),
  unique (restaurant_id, date)
);
create table public.menu_items (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  name text not null check (length(trim(name)) > 0), description text not null default '',
  price_cents integer not null check (price_cents >= 0), category text not null, dietary_tags text[] not null default '{}', available boolean not null default true
);
create table public.menu_modifiers (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  menu_item_id uuid not null references public.menu_items(id) on delete cascade,
  name text not null check (length(trim(name)) > 0), price_delta_cents integer not null check (price_delta_cents >= 0),
  required boolean not null default false, max_select integer not null check (max_select > 0), unique(menu_item_id, name)
);
create table public.faqs (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  question text not null check (length(trim(question)) > 0), answer text not null check (length(trim(answer)) > 0),
  language text not null check (language in ('en','fr-CA','ur','hi','pa')), source text not null check (source in ('import','owner','teach'))
);
create table public.agents (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  persona_name text not null, filler_level text not null check (filler_level in ('none','low','natural')),
  current_published_version_id uuid, enabled boolean not null default true, unique (restaurant_id)
);
create table public.agent_versions (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  agent_id uuid not null references public.agents(id) on delete cascade, version_no integer not null check (version_no > 0),
  status text not null check (status in ('draft','published','archived')), prompt_sections jsonb not null default '{}'::jsonb,
  voices jsonb not null default '{}'::jsonb, rules jsonb not null default '{}'::jsonb,
  published_at timestamptz, published_by uuid references auth.users(id) on delete set null,
  unique (agent_id, version_no)
);
alter table public.agents add constraint agents_current_published_version_fk foreign key (current_published_version_id) references public.agent_versions(id) on delete set null;
create unique index agent_versions_one_draft_idx on public.agent_versions(agent_id) where status = 'draft';
create unique index agent_versions_one_published_idx on public.agent_versions(agent_id) where status = 'published';
create table public.audio_cache (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  agent_version_id uuid not null references public.agent_versions(id) on delete cascade,
  language text not null check (language in ('en','fr-CA','ur','hi','pa')), phrase_key text not null, storage_path text not null,
  unique (agent_version_id, language, phrase_key)
);
create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  e164 text not null check (e164 ~ '^\+[1-9][0-9]{7,14}$'), telnyx_number_id text not null unique,
  status text not null check (status in ('pending','active','released')), forwarding_verified_at timestamptz, unique (restaurant_id, e164)
);
create table public.calls (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  agent_version_id uuid not null references public.agent_versions(id), telnyx_call_id text not null unique,
  from_e164_hash text not null, from_last4 text not null check (from_last4 ~ '^[0-9]{4}$'),
  started_at timestamptz not null, ended_at timestamptz, billable_seconds integer not null default 0 check (billable_seconds >= 0),
  outcome text check (outcome in ('booking','order','message','answered','transferred')),
  languages text[] not null default '{}', transferred boolean not null default false, recording_path text,
  summary text not null default '', qa_flags text[] not null default '{}', cost_micros jsonb not null default '{}'::jsonb,
  check (ended_at is null or ended_at >= started_at)
);
create table public.call_turns (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  call_id uuid not null references public.calls(id) on delete cascade, idx integer not null check (idx >= 0),
  speaker text not null check (speaker in ('caller','agent')), language text not null check (language in ('en','fr-CA','ur','hi','pa')),
  text text not null, started_ms integer not null check (started_ms >= 0), ended_ms integer not null check (ended_ms >= started_ms),
  interrupted boolean not null default false, unique(call_id, idx)
);
create table public.call_metrics (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  call_id uuid not null references public.calls(id) on delete cascade, turn_idx integer not null check (turn_idx >= 0),
  eot_ms integer not null check (eot_ms >= 0), stt_ms integer not null check (stt_ms >= 0), llm_ttft_ms integer not null check (llm_ttft_ms >= 0),
  tts_ttfb_ms integer not null check (tts_ttfb_ms >= 0), total_ms integer not null check (total_ms >= 0), unique(call_id, turn_idx)
);
create table public.tool_invocations (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  call_id uuid not null references public.calls(id) on delete cascade, tool text not null, args jsonb not null default '{}'::jsonb,
  result jsonb, status text not null check (status in ('started','succeeded','failed','timed_out')),
  duration_ms integer check (duration_ms >= 0), idempotency_key text not null unique
);
create table public.slots_config (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  slot_minutes integer not null check (slot_minutes > 0), covers_per_slot integer not null check (covers_per_slot > 0),
  seating_minutes integer not null check (seating_minutes > 0), max_party integer not null check (max_party > 0),
  lead_time_minutes integer not null check (lead_time_minutes >= 0), booking_window_days integer not null check (booking_window_days > 0), unique(restaurant_id)
);
create table public.bookings (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade, call_id uuid references public.calls(id) on delete set null,
  name text not null check (length(trim(name)) > 0), phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  party_size integer not null check (party_size > 0), starts_at timestamptz not null,
  status text not null check (status in ('confirmed','seated','cancelled','no-show')), notes text not null default '', source text not null check (source in ('call','owner'))
);
create table public.orders (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade, call_id uuid references public.calls(id) on delete set null,
  name text not null, phone text not null, pickup_at timestamptz not null,
  subtotal_cents integer not null check (subtotal_cents >= 0), tax_cents integer not null check (tax_cents >= 0), total_cents integer not null check (total_cents = subtotal_cents + tax_cents),
  paid_status text not null check (paid_status in ('unpaid','paid','refunded')), status text not null check (status in ('new','in-progress','ready'))
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  order_id uuid not null references public.orders(id) on delete cascade, item text not null, modifiers text[] not null default '{}',
  modifier_price_cents integer[] not null default '{}', quantity integer not null check (quantity > 0), price_cents integer not null check (price_cents >= 0)
);
create table public.messages (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade, call_id uuid references public.calls(id) on delete set null,
  caller_name text not null, phone text not null, text text not null, handled boolean not null default false
);
create table public.sms_log (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade, to_e164 text not null check (to_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  body text not null, status text not null check (status in ('queued','sent','delivered','failed'))
);
create table public.sms_optouts (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade, phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'), unique(restaurant_id, phone_e164)
);
create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade, period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  seconds integer not null check (seconds >= 0), stripe_reported boolean not null default false, cost_micros bigint not null default 0 check (cost_micros >= 0),
  unique(organization_id, period)
);
create table public.audit_log (
  id uuid primary key default gen_random_uuid(), created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null, action text not null, target text not null, reason text not null
);

do $$ declare table_name text; begin
  foreach table_name in array array['organizations','memberships','restaurants','hours','hours_overrides','menu_items','menu_modifiers','faqs','agents','agent_versions','audio_cache','phone_numbers','calls','call_turns','call_metrics','tool_invocations','slots_config','bookings','orders','order_items','messages','sms_log','sms_optouts','usage_ledger','audit_log']
  loop execute format('create trigger set_%I_updated_at before update on public.%I for each row execute function private.set_updated_at()', table_name, table_name); end loop;
end $$;

create index memberships_user_id_idx on public.memberships(user_id);
create index memberships_organization_id_idx on public.memberships(organization_id);
create index restaurants_organization_id_idx on public.restaurants(organization_id);
create index hours_restaurant_id_idx on public.hours(restaurant_id);
create index hours_overrides_restaurant_id_idx on public.hours_overrides(restaurant_id);
create index menu_items_restaurant_id_idx on public.menu_items(restaurant_id);
create index menu_modifiers_menu_item_id_idx on public.menu_modifiers(menu_item_id);
create index faqs_restaurant_id_idx on public.faqs(restaurant_id);
create index agents_restaurant_id_idx on public.agents(restaurant_id);
create index agents_current_published_version_id_idx on public.agents(current_published_version_id);
create index agent_versions_agent_id_idx on public.agent_versions(agent_id);
create index agent_versions_published_by_idx on public.agent_versions(published_by);
create index audio_cache_agent_version_id_idx on public.audio_cache(agent_version_id);
create index phone_numbers_restaurant_id_idx on public.phone_numbers(restaurant_id);
create index calls_restaurant_id_started_at_idx on public.calls(restaurant_id, started_at desc);
create index calls_agent_version_id_idx on public.calls(agent_version_id);
create index call_turns_call_id_idx on public.call_turns(call_id);
create index call_metrics_call_id_idx on public.call_metrics(call_id);
create index tool_invocations_call_id_idx on public.tool_invocations(call_id);
create index slots_config_restaurant_id_idx on public.slots_config(restaurant_id);
create index bookings_restaurant_starts_at_idx on public.bookings(restaurant_id, starts_at);
create index bookings_call_id_idx on public.bookings(call_id);
create index orders_restaurant_id_idx on public.orders(restaurant_id);
create index orders_call_id_idx on public.orders(call_id);
create index order_items_order_id_idx on public.order_items(order_id);
create index messages_restaurant_id_idx on public.messages(restaurant_id);
create index messages_call_id_idx on public.messages(call_id);
create index sms_log_restaurant_id_idx on public.sms_log(restaurant_id);
create index sms_optouts_restaurant_id_idx on public.sms_optouts(restaurant_id);
create index usage_ledger_organization_id_idx on public.usage_ledger(organization_id);
create index audit_log_actor_id_idx on public.audit_log(actor_id);
