-- RLS performance and security patterns: https://supabase.com/docs/guides/database/postgres/row-level-security
create or replace function private.user_organization_ids()
returns setof uuid language sql security definer stable set search_path = '' as $$
  select organization_id from public.memberships where user_id = (select auth.uid())
$$;
create or replace function private.user_owned_organization_ids()
returns setof uuid language sql security definer stable set search_path = '' as $$
  select organization_id from public.memberships where user_id = (select auth.uid()) and role = 'owner'
$$;
create or replace function private.user_restaurant_ids()
returns setof uuid language sql security definer stable set search_path = '' as $$
  select r.id from public.restaurants r join public.memberships m on m.organization_id=r.organization_id
  where m.user_id=(select auth.uid())
$$;
create or replace function private.is_restaurant_owner(p_restaurant_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists(
    select 1 from public.restaurants r join public.memberships m on m.organization_id=r.organization_id
    where r.id=p_restaurant_id and m.user_id=(select auth.uid()) and m.role='owner'
  )
$$;
revoke execute on function private.user_organization_ids() from public;
revoke execute on function private.user_owned_organization_ids() from public;
revoke execute on function private.user_restaurant_ids() from public;
revoke execute on function private.is_restaurant_owner(uuid) from public;
grant usage on schema private to authenticated;
grant execute on function private.user_organization_ids() to authenticated;
grant execute on function private.user_owned_organization_ids() to authenticated;
grant execute on function private.user_restaurant_ids() to authenticated;
grant execute on function private.is_restaurant_owner(uuid) to authenticated;

do $$ declare table_name text; begin
  foreach table_name in array array['organizations','memberships','restaurants','hours','hours_overrides','menu_items','menu_modifiers','faqs','agents','agent_versions','audio_cache','phone_numbers','calls','call_turns','call_metrics','tool_invocations','slots_config','bookings','orders','order_items','messages','sms_log','sms_optouts','usage_ledger','audit_log']
  loop execute format('alter table public.%I enable row level security',table_name); end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;
grant select on public.organizations,public.memberships,public.restaurants,public.hours,public.hours_overrides,public.menu_items,
  public.menu_modifiers,public.faqs,public.agents,public.agent_versions,public.phone_numbers,public.calls,public.call_turns,
  public.call_metrics,public.tool_invocations,public.slots_config,public.bookings,public.orders,public.order_items,public.messages,
  public.sms_log,public.sms_optouts,public.usage_ledger to authenticated;
grant update on public.organizations to authenticated;
grant insert,update,delete on public.restaurants,public.hours,public.hours_overrides,public.menu_items,public.menu_modifiers,
  public.faqs,public.phone_numbers,public.slots_config,public.sms_optouts to authenticated;
grant insert,delete on public.agents to authenticated;
grant update(persona_name,filler_level,enabled) on public.agents to authenticated;
grant insert,update,delete on public.bookings,public.orders,public.order_items to authenticated;
grant update(handled) on public.messages to authenticated;

create policy organizations_select on public.organizations for select to authenticated using(id in(select private.user_organization_ids()));
create policy organizations_owner_update on public.organizations for update to authenticated
  using(id in(select private.user_owned_organization_ids())) with check(id in(select private.user_owned_organization_ids()));
create policy memberships_select on public.memberships for select to authenticated using(organization_id in(select private.user_organization_ids()));
create policy restaurants_select on public.restaurants for select to authenticated using(id in(select private.user_restaurant_ids()));
create policy restaurants_owner_insert on public.restaurants for insert to authenticated with check(organization_id in(select private.user_owned_organization_ids()));
create policy restaurants_owner_update on public.restaurants for update to authenticated using(private.is_restaurant_owner(id)) with check(organization_id in(select private.user_owned_organization_ids()));
create policy restaurants_owner_delete on public.restaurants for delete to authenticated using(private.is_restaurant_owner(id));

create policy hours_select on public.hours for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy hours_owner_write on public.hours for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy hours_overrides_select on public.hours_overrides for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy hours_overrides_owner_write on public.hours_overrides for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy menu_items_select on public.menu_items for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy menu_items_owner_write on public.menu_items for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy faqs_select on public.faqs for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy faqs_owner_write on public.faqs for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy agents_select on public.agents for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy agents_owner_write on public.agents for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy phone_numbers_select on public.phone_numbers for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy phone_numbers_owner_write on public.phone_numbers for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy slots_config_select on public.slots_config for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy slots_config_owner_write on public.slots_config for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));
create policy sms_optouts_select on public.sms_optouts for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy sms_optouts_owner_write on public.sms_optouts for all to authenticated using(private.is_restaurant_owner(restaurant_id)) with check(private.is_restaurant_owner(restaurant_id));

create policy menu_modifiers_select on public.menu_modifiers for select to authenticated using(exists(select 1 from public.menu_items i where i.id=menu_item_id and i.restaurant_id in(select private.user_restaurant_ids())));
create policy menu_modifiers_owner_write on public.menu_modifiers for all to authenticated
  using(exists(select 1 from public.menu_items i where i.id=menu_item_id and private.is_restaurant_owner(i.restaurant_id)))
  with check(exists(select 1 from public.menu_items i where i.id=menu_item_id and private.is_restaurant_owner(i.restaurant_id)));
create policy agent_versions_select on public.agent_versions for select to authenticated
  using(exists(select 1 from public.agents a where a.id=agent_id and a.restaurant_id in(select private.user_restaurant_ids())));

create policy calls_select on public.calls for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy call_turns_select on public.call_turns for select to authenticated using(exists(select 1 from public.calls c where c.id=call_id and c.restaurant_id in(select private.user_restaurant_ids())));
create policy call_metrics_select on public.call_metrics for select to authenticated using(exists(select 1 from public.calls c where c.id=call_id and c.restaurant_id in(select private.user_restaurant_ids())));
create policy tool_invocations_select on public.tool_invocations for select to authenticated using(exists(select 1 from public.calls c where c.id=call_id and c.restaurant_id in(select private.user_restaurant_ids())));
create policy sms_log_select on public.sms_log for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy usage_ledger_select on public.usage_ledger for select to authenticated using(organization_id in(select private.user_organization_ids()));

create policy bookings_select on public.bookings for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy bookings_member_insert on public.bookings for insert to authenticated with check(restaurant_id in(select private.user_restaurant_ids()));
create policy bookings_member_update on public.bookings for update to authenticated using(restaurant_id in(select private.user_restaurant_ids())) with check(restaurant_id in(select private.user_restaurant_ids()));
create policy bookings_owner_delete on public.bookings for delete to authenticated using(private.is_restaurant_owner(restaurant_id));
create policy orders_select on public.orders for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy orders_member_insert on public.orders for insert to authenticated with check(restaurant_id in(select private.user_restaurant_ids()));
create policy orders_member_update on public.orders for update to authenticated using(restaurant_id in(select private.user_restaurant_ids())) with check(restaurant_id in(select private.user_restaurant_ids()));
create policy orders_owner_delete on public.orders for delete to authenticated using(private.is_restaurant_owner(restaurant_id));
create policy order_items_select on public.order_items for select to authenticated using(exists(select 1 from public.orders o where o.id=order_id and o.restaurant_id in(select private.user_restaurant_ids())));
create policy order_items_member_insert on public.order_items for insert to authenticated with check(exists(select 1 from public.orders o where o.id=order_id and o.restaurant_id in(select private.user_restaurant_ids())));
create policy order_items_member_update on public.order_items for update to authenticated using(exists(select 1 from public.orders o where o.id=order_id and o.restaurant_id in(select private.user_restaurant_ids()))) with check(exists(select 1 from public.orders o where o.id=order_id and o.restaurant_id in(select private.user_restaurant_ids())));
create policy order_items_owner_delete on public.order_items for delete to authenticated using(exists(select 1 from public.orders o where o.id=order_id and private.is_restaurant_owner(o.restaurant_id)));
create policy messages_select on public.messages for select to authenticated using(restaurant_id in(select private.user_restaurant_ids()));
create policy messages_member_update on public.messages for update to authenticated using(restaurant_id in(select private.user_restaurant_ids())) with check(restaurant_id in(select private.user_restaurant_ids()));

create or replace function private.enforce_tenant_relationships()
returns trigger language plpgsql set search_path = '' as $$
declare v_restaurant_id uuid; v_agent_id uuid;
begin
  if tg_table_name='calls' then
    select a.restaurant_id into v_restaurant_id from public.agent_versions v join public.agents a on a.id=v.agent_id where v.id=new.agent_version_id;
    if v_restaurant_id is distinct from new.restaurant_id then raise exception 'CROSS_TENANT_AGENT_VERSION' using errcode='23514'; end if;
  elsif tg_table_name in('bookings','orders','messages') then
    if new.call_id is not null then
      select restaurant_id into v_restaurant_id from public.calls where id=new.call_id;
      if v_restaurant_id is distinct from new.restaurant_id then raise exception 'CROSS_TENANT_CALL' using errcode='23514'; end if;
    end if;
  elsif tg_table_name='agents' then
    if new.current_published_version_id is not null then
      select agent_id into v_agent_id from public.agent_versions where id=new.current_published_version_id;
      if v_agent_id is distinct from new.id then raise exception 'CROSS_AGENT_PUBLISHED_VERSION' using errcode='23514'; end if;
    end if;
  end if;
  return new;
end $$;
create constraint trigger calls_tenant_relationship after insert or update of restaurant_id,agent_version_id on public.calls deferrable initially immediate for each row execute function private.enforce_tenant_relationships();
create constraint trigger bookings_tenant_relationship after insert or update of restaurant_id,call_id on public.bookings deferrable initially immediate for each row execute function private.enforce_tenant_relationships();
create constraint trigger orders_tenant_relationship after insert or update of restaurant_id,call_id on public.orders deferrable initially immediate for each row execute function private.enforce_tenant_relationships();
create constraint trigger messages_tenant_relationship after insert or update of restaurant_id,call_id on public.messages deferrable initially immediate for each row execute function private.enforce_tenant_relationships();
create constraint trigger agents_published_version_relationship after insert or update of current_published_version_id on public.agents deferrable initially immediate for each row execute function private.enforce_tenant_relationships();

create or replace function private.enforce_booking_capacity()
returns trigger language plpgsql set search_path = '' as $$
declare v_capacity integer; v_max_party integer; v_seating integer; v_reserved integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.restaurant_id::text,0));
  select covers_per_slot,max_party,seating_minutes into v_capacity,v_max_party,v_seating from public.slots_config where restaurant_id=new.restaurant_id;
  if not found then raise exception 'SLOTS_CONFIG_NOT_FOUND' using errcode='23514'; end if;
  if new.party_size<=0 or new.party_size>v_max_party then raise exception 'MAX_PARTY' using errcode='23514'; end if;
  if new.status not in('confirmed','seated') then return new; end if;
  select coalesce(sum(b.party_size),0)::integer into v_reserved from public.bookings b
  where b.restaurant_id=new.restaurant_id and b.id<>new.id and b.status in('confirmed','seated')
    and b.starts_at < new.starts_at + make_interval(mins=>v_seating)
    and b.starts_at + make_interval(mins=>v_seating) > new.starts_at;
  if v_reserved+new.party_size>v_capacity then raise exception 'CAPACITY' using errcode='23514'; end if;
  return new;
end $$;
create trigger bookings_capacity before insert or update of restaurant_id,party_size,starts_at,status on public.bookings for each row execute function private.enforce_booking_capacity();

create or replace function public.create_booking(p_restaurant_id uuid,p_name text,p_phone_e164 text,p_party_size integer,p_starts_at timestamptz,p_notes text default '')
returns public.bookings language plpgsql set search_path = '' as $$
declare v_booking public.bookings;
begin
  insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,notes,source)
  values(p_restaurant_id,p_name,p_phone_e164,p_party_size,p_starts_at,'confirmed',coalesce(p_notes,''),'owner') returning * into v_booking;
  return v_booking;
end $$;
revoke execute on function public.create_booking(uuid,text,text,integer,timestamptz,text) from public;
grant execute on function public.create_booking(uuid,text,text,integer,timestamptz,text) to authenticated;

create or replace function public.save_agent_draft(p_agent_id uuid,p_prompt_sections jsonb,p_voices jsonb,p_rules jsonb)
returns public.agent_versions language plpgsql security definer set search_path = '' as $$
declare v_version public.agent_versions; v_next integer; v_restaurant_id uuid;
begin
  select restaurant_id into v_restaurant_id from public.agents where id=p_agent_id for update;
  if not found then raise exception 'AGENT_NOT_FOUND' using errcode='P0002'; end if;
  if not private.is_restaurant_owner(v_restaurant_id) then raise exception 'OWNER_REQUIRED' using errcode='42501'; end if;
  select * into v_version from public.agent_versions where agent_id=p_agent_id and status='draft';
  if found then update public.agent_versions set prompt_sections=p_prompt_sections,voices=p_voices,rules=p_rules where id=v_version.id returning * into v_version;
  else
    select coalesce(max(version_no),0)+1 into v_next from public.agent_versions where agent_id=p_agent_id;
    insert into public.agent_versions(agent_id,version_no,status,prompt_sections,voices,rules) values(p_agent_id,v_next,'draft',p_prompt_sections,p_voices,p_rules) returning * into v_version;
  end if;
  return v_version;
end $$;
create or replace function public.publish_agent_version(p_version_id uuid)
returns public.agent_versions language plpgsql security definer set search_path = '' as $$
declare v_version public.agent_versions; v_restaurant_id uuid;
begin
  select * into v_version from public.agent_versions where id=p_version_id;
  if not found then raise exception 'AGENT_VERSION_NOT_FOUND' using errcode='P0002'; end if;
  select restaurant_id into v_restaurant_id from public.agents where id=v_version.agent_id;
  if not private.is_restaurant_owner(v_restaurant_id) then raise exception 'OWNER_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.agents where id=v_version.agent_id for update;
  update public.agent_versions set status='archived' where agent_id=v_version.agent_id and status='published' and id<>p_version_id;
  update public.agent_versions set status='published',published_at=now(),published_by=(select auth.uid()) where id=p_version_id returning * into v_version;
  update public.agents set current_published_version_id=p_version_id where id=v_version.agent_id;
  return v_version;
end $$;
create or replace function public.restore_agent_version(p_version_id uuid)
returns public.agent_versions language plpgsql security definer set search_path = '' as $$
declare v_source public.agent_versions; v_version public.agent_versions; v_next integer; v_restaurant_id uuid;
begin
  select * into v_source from public.agent_versions where id=p_version_id;
  if not found then raise exception 'AGENT_VERSION_NOT_FOUND' using errcode='P0002'; end if;
  select restaurant_id into v_restaurant_id from public.agents where id=v_source.agent_id;
  if not private.is_restaurant_owner(v_restaurant_id) then raise exception 'OWNER_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.agents where id=v_source.agent_id for update;
  update public.agent_versions set status='archived' where agent_id=v_source.agent_id and status='draft';
  select coalesce(max(version_no),0)+1 into v_next from public.agent_versions where agent_id=v_source.agent_id;
  insert into public.agent_versions(agent_id,version_no,status,prompt_sections,voices,rules)
  values(v_source.agent_id,v_next,'draft',v_source.prompt_sections,v_source.voices,v_source.rules) returning * into v_version;
  return v_version;
end $$;
revoke execute on function public.save_agent_draft(uuid,jsonb,jsonb,jsonb) from public;
revoke execute on function public.publish_agent_version(uuid) from public;
revoke execute on function public.restore_agent_version(uuid) from public;
grant execute on function public.save_agent_draft(uuid,jsonb,jsonb,jsonb) to authenticated;
grant execute on function public.publish_agent_version(uuid) to authenticated;
grant execute on function public.restore_agent_version(uuid) to authenticated;
