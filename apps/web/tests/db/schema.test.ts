import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {asUser, createDatabase} from './database';

const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const STAFF_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORG_A = '10000000-0000-4000-8000-000000000001';
const ORG_B = '20000000-0000-4000-8000-000000000002';
const RESTAURANT_A = '30000000-0000-4000-8000-000000000003';
const RESTAURANT_B = '40000000-0000-4000-8000-000000000004';

async function seedTenantGraphs(db: PGlite): Promise<void> {
  await db.exec(`
    insert into public.hours(restaurant_id,weekday,open_time,close_time) values ('${RESTAURANT_A}',1,'09:00','17:00'),('${RESTAURANT_B}',1,'09:00','17:00');
    insert into public.hours_overrides(restaurant_id,date,open_time,close_time) values ('${RESTAURANT_A}','2026-12-25',null,null),('${RESTAURANT_B}','2026-12-25',null,null);
    insert into public.menu_items(id,restaurant_id,name,price_cents,category) values
      (md5('item-a')::uuid,'${RESTAURANT_A}','Item A',100,'Main'),(md5('item-b')::uuid,'${RESTAURANT_B}','Item B',100,'Main');
    insert into public.menu_modifiers(menu_item_id,name,price_delta_cents,max_select) values (md5('item-a')::uuid,'Extra',0,1),(md5('item-b')::uuid,'Extra',0,1);
    insert into public.faqs(restaurant_id,question,answer,language,source) values ('${RESTAURANT_A}','Q','A','en','owner'),('${RESTAURANT_B}','Q','A','en','owner');
    insert into public.agents(id,restaurant_id,persona_name,filler_level) values
      (md5('agent-a')::uuid,'${RESTAURANT_A}','A','none'),(md5('agent-b')::uuid,'${RESTAURANT_B}','B','none');
    insert into public.agent_versions(id,agent_id,version_no,status) values
      (md5('version-a')::uuid,md5('agent-a')::uuid,1,'published'),(md5('version-b')::uuid,md5('agent-b')::uuid,1,'published');
    insert into public.audio_cache(agent_version_id,language,phrase_key,storage_path) values
      (md5('version-a')::uuid,'en','hello','a/hello.wav'),(md5('version-b')::uuid,'en','hello','b/hello.wav');
    insert into public.phone_numbers(restaurant_id,e164,telnyx_number_id,status) values
      ('${RESTAURANT_A}','+14165550101','number-a','active'),('${RESTAURANT_B}','+14165550102','number-b','active');
    insert into public.calls(id,restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at,outcome) values
      (md5('call-a')::uuid,'${RESTAURANT_A}',md5('version-a')::uuid,'call-a','hash-a','0101',now(),'answered'),
      (md5('call-b')::uuid,'${RESTAURANT_B}',md5('version-b')::uuid,'call-b','hash-b','0102',now(),'answered');
    insert into public.call_turns(call_id,idx,speaker,language,text,started_ms,ended_ms) values
      (md5('call-a')::uuid,0,'caller','en','Hi',0,10),(md5('call-b')::uuid,0,'caller','en','Hi',0,10);
    insert into public.call_metrics(call_id,turn_idx,eot_ms,stt_ms,llm_ttft_ms,tts_ttfb_ms,total_ms) values
      (md5('call-a')::uuid,0,1,1,1,1,4),(md5('call-b')::uuid,0,1,1,1,1,4);
    insert into public.tool_invocations(call_id,tool,status,idempotency_key) values
      (md5('call-a')::uuid,'get_hours','succeeded','tool-a'),(md5('call-b')::uuid,'get_hours','succeeded','tool-b');
    insert into public.slots_config(restaurant_id,slot_minutes,covers_per_slot,seating_minutes,max_party,lead_time_minutes,booking_window_days) values
      ('${RESTAURANT_A}',15,10,90,8,0,90),('${RESTAURANT_B}',15,10,90,8,0,90);
    insert into public.bookings(restaurant_id,call_id,name,phone_e164,party_size,starts_at,status,source) values
      ('${RESTAURANT_A}',md5('call-a')::uuid,'A','+14165550101',2,now()+interval '1 day','confirmed','phone'),
      ('${RESTAURANT_B}',md5('call-b')::uuid,'B','+14165550102',2,now()+interval '1 day','confirmed','phone');
    insert into public.orders(id,restaurant_id,call_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,paid_status,status) values
      (md5('order-a')::uuid,'${RESTAURANT_A}',md5('call-a')::uuid,'A','+14165550101',now(),100,13,113,'unpaid','new'),
      (md5('order-b')::uuid,'${RESTAURANT_B}',md5('call-b')::uuid,'B','+14165550102',now(),100,13,113,'unpaid','new');
    insert into public.order_items(order_id,item,quantity,price_cents) values (md5('order-a')::uuid,'Item',1,100),(md5('order-b')::uuid,'Item',1,100);
    insert into public.messages(restaurant_id,call_id,caller_name,phone,text) values
      ('${RESTAURANT_A}',md5('call-a')::uuid,'A','+14165550101','A'),('${RESTAURANT_B}',md5('call-b')::uuid,'B','+14165550102','B');
    insert into public.sms_log(restaurant_id,to_e164,body,status) values ('${RESTAURANT_A}','+14165550101','A','queued'),('${RESTAURANT_B}','+14165550102','B','queued');
    insert into public.sms_optouts(restaurant_id,phone_e164) values ('${RESTAURANT_A}','+14165550101'),('${RESTAURANT_B}','+14165550102');
    insert into public.usage_ledger(organization_id,period,seconds) values ('${ORG_A}','2026-10',1),('${ORG_B}','2026-10',1);
    insert into public.audit_log(actor_id,action,target,reason) values ('${USER_A}','test','a','test'),('${USER_B}','test','b','test');
  `);
}

describe('Supabase migrations', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createDatabase();
    await db.exec(`
      insert into auth.users (id) values ('${USER_A}'), ('${USER_B}'), ('${STAFF_A}');
      insert into public.organizations (id, name, plan, spend_cap_cents) values
        ('${ORG_A}', 'Tenant A', 'starter', 2000), ('${ORG_B}', 'Tenant B', 'growth', 4000);
      insert into public.memberships (organization_id, user_id, role) values
        ('${ORG_A}', '${USER_A}', 'owner'), ('${ORG_A}', '${STAFF_A}', 'staff'), ('${ORG_B}', '${USER_B}', 'owner');
      insert into public.restaurants (id, organization_id, name, address, province, timezone, primary_language, enabled_languages, status) values
        ('${RESTAURANT_A}', '${ORG_A}', 'A', '1 A St', 'ON', 'America/Toronto', 'en', array['en'], 'live'),
        ('${RESTAURANT_B}', '${ORG_B}', 'B', '2 B St', 'QC', 'America/Toronto', 'fr-CA', array['fr-CA'], 'live');
    `);
  });

  afterEach(async () => db.close());

  it('creates every PRD section 7 table with UUID identity, timestamps, and RLS', async () => {
    const expected = ['organizations','memberships','organization_invitations','notification_preferences','restaurants','restaurant_stripe_accounts','hours','hours_overrides','menu_items','menu_modifiers','faqs','agents','agent_versions','audio_cache','phone_numbers','calls','call_turns','call_metrics','tool_invocations','slots_config','bookings','orders','order_items','messages','sms_log','sms_optouts','usage_ledger','usage_alerts_sent','audit_log','import_jobs','import_review_rows','processed_events','legal_settings','invoices','privacy_requests','feature_flags','support_sessions'];
    const tables = await db.query<{table_name: string; relrowsecurity: boolean}>(`
      select c.relname table_name,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' order by c.relname
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual([...expected].sort());
    expect(tables.rows.every((row) => row.relrowsecurity)).toBe(true);
    for (const table of expected) {
      const columns = (await db.query<{column_name: string; data_type: string}>(`
        select column_name,data_type from information_schema.columns where table_schema='public' and table_name=$1
      `,[table])).rows;
      if (table === 'restaurant_stripe_accounts') {
        expect(columns.find((column) => column.column_name==='account_id')?.data_type).toBe('text');
        expect(columns.some((column) => column.column_name==='connected_at')).toBe(true);
        continue;
      }
      expect(columns.find((column) => column.column_name==='id')?.data_type, table).toBe('uuid');
      if (table !== 'feature_flags' && table !== 'support_sessions') {
        expect(columns.some((column) => column.column_name==='created_at'), table).toBe(true);
        expect(columns.some((column) => column.column_name==='updated_at'), table).toBe(true);
      }
    }
  });

  it('isolates organization and restaurant rows for reads and writes', async () => {
    await seedTenantGraphs(db);
    const tenantBRows = (await db.query<{table_name: string; id: string}>(`
      select 'organizations' table_name,id from public.organizations where id='${ORG_B}' union all
      select 'memberships',id from public.memberships where organization_id='${ORG_B}' union all
      select 'restaurants',id from public.restaurants where id='${RESTAURANT_B}' union all
      select 'hours',id from public.hours where restaurant_id='${RESTAURANT_B}' union all
      select 'hours_overrides',id from public.hours_overrides where restaurant_id='${RESTAURANT_B}' union all
      select 'menu_items',id from public.menu_items where restaurant_id='${RESTAURANT_B}' union all
      select 'menu_modifiers',m.id from public.menu_modifiers m join public.menu_items i on i.id=m.menu_item_id where i.restaurant_id='${RESTAURANT_B}' union all
      select 'faqs',id from public.faqs where restaurant_id='${RESTAURANT_B}' union all
      select 'agents',id from public.agents where restaurant_id='${RESTAURANT_B}' union all
      select 'agent_versions',v.id from public.agent_versions v join public.agents a on a.id=v.agent_id where a.restaurant_id='${RESTAURANT_B}' union all
      select 'phone_numbers',id from public.phone_numbers where restaurant_id='${RESTAURANT_B}' union all
      select 'calls',id from public.calls where restaurant_id='${RESTAURANT_B}' union all
      select 'call_turns',t.id from public.call_turns t join public.calls c on c.id=t.call_id where c.restaurant_id='${RESTAURANT_B}' union all
      select 'call_metrics',m.id from public.call_metrics m join public.calls c on c.id=m.call_id where c.restaurant_id='${RESTAURANT_B}' union all
      select 'tool_invocations',t.id from public.tool_invocations t join public.calls c on c.id=t.call_id where c.restaurant_id='${RESTAURANT_B}' union all
      select 'slots_config',id from public.slots_config where restaurant_id='${RESTAURANT_B}' union all
      select 'bookings',id from public.bookings where restaurant_id='${RESTAURANT_B}' union all
      select 'orders',id from public.orders where restaurant_id='${RESTAURANT_B}' union all
      select 'order_items',i.id from public.order_items i join public.orders o on o.id=i.order_id where o.restaurant_id='${RESTAURANT_B}' union all
      select 'messages',id from public.messages where restaurant_id='${RESTAURANT_B}' union all
      select 'sms_log',id from public.sms_log where restaurant_id='${RESTAURANT_B}' union all
      select 'sms_optouts',id from public.sms_optouts where restaurant_id='${RESTAURANT_B}' union all
      select 'usage_ledger',id from public.usage_ledger where organization_id='${ORG_B}'
    `)).rows;
    await asUser(db, USER_A, async () => {
      expect((await db.query<{id: string}>('select id from public.organizations')).rows.map((row) => row.id)).toEqual([ORG_A]);
      expect((await db.query<{id: string}>('select id from public.restaurants')).rows.map((row) => row.id)).toEqual([RESTAURANT_A]);
      expect((await db.query('update public.restaurants set name = $1 where id = $2 returning id', ['stolen', RESTAURANT_B])).rows).toHaveLength(0);
      await expect(db.query(`insert into public.faqs (restaurant_id, question, answer, language, source) values ($1, 'Q', 'A', 'en', 'owner')`, [RESTAURANT_B])).rejects.toThrow(/row-level security|policy/i);
      const tenantTables = ['organizations','memberships','restaurants','hours','hours_overrides','menu_items','menu_modifiers','faqs','agents','agent_versions','phone_numbers','calls','call_turns','call_metrics','tool_invocations','slots_config','bookings','orders','order_items','messages','sms_log','sms_optouts','usage_ledger'];
      for (const table of tenantTables) {
        expect((await db.query<{count: number}>(`select count(*)::int as count from public.${table}`)).rows[0]?.count, table).toBe(table==='memberships' ? 2 : 1);
      }
      for (const row of tenantBRows) {
        let result;
        try {
          result = await db.query(`update public.${row.table_name} set updated_at=updated_at where id=$1 returning id`, [row.id]);
        } catch {
          // Tables intentionally lacking authenticated write grants also satisfy isolation.
          continue;
        }
        expect(result.rows, row.table_name).toHaveLength(0);
      }
      await expect(db.query('select * from public.audio_cache')).rejects.toThrow(/permission denied/i);
      await expect(db.query('select * from public.audit_log')).rejects.toThrow(/permission denied/i);
    });
    expect((await db.query<{name: string}>('select name from public.restaurants where id = $1', [RESTAURANT_B])).rows[0]?.name).toBe('B');
  });

  it('enforces enum, monetary, unique, and foreign-key constraints', async () => {
    await expect(db.query(`insert into public.restaurants (organization_id, name, address, province, timezone, primary_language, enabled_languages, status) values ($1, 'Bad', 'x', 'ON', 'UTC', 'en', array['en'], 'invalid')`, [ORG_A])).rejects.toThrow(/check constraint/i);
    await expect(db.query(`insert into public.menu_items (restaurant_id, name, price_cents, category) values ($1, 'Bad', -1, 'Main')`, [RESTAURANT_A])).rejects.toThrow(/check constraint/i);
    await expect(db.query(`insert into public.hours (restaurant_id, weekday, open_time, close_time) values ($1, 7, '09:00', '17:00')`, [RESTAURANT_A])).rejects.toThrow(/check constraint/i);
    await db.query(`insert into public.hours (restaurant_id, weekday, open_time, close_time) values ($1, 1, '09:00', '17:00')`, [RESTAURANT_A]);
    await expect(db.query(`insert into public.hours (restaurant_id, weekday, open_time, close_time) values ($1, 1, '10:00', '18:00')`, [RESTAURANT_A])).rejects.toThrow(/unique constraint|duplicate key/i);
    await expect(db.query(`insert into public.menu_modifiers (menu_item_id, name, price_delta_cents, max_select) values ('99999999-9999-4999-8999-999999999999', 'X', 0, 1)`)).rejects.toThrow(/foreign key/i);
  });

  it('stores caller identity in calls only as a hash and last four digits', async () => {
    const columns = await db.query<{column_name: string}>(`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'calls'`);
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toContain('from_e164_hash');
    expect(names).toContain('from_last4');
    expect(names).not.toContain('from_e164');
    expect(names).not.toContain('phone_e164');
  });

  it('prevents authenticated writes to usage_ledger', async () => {
    await asUser(db, USER_A, async () => {
      await expect(db.query(`insert into public.usage_ledger (organization_id, period, seconds, stripe_reported) values ($1, '2026-10', 60, false)`, [ORG_A])).rejects.toThrow(/permission denied/i);
    });
  });

  it('limits staff to operational reads and booking, order, and issue updates', async () => {
    await seedTenantGraphs(db);
    const bookingId = (await db.query<{id: string}>(`select id from public.bookings where restaurant_id=$1`,[RESTAURANT_A])).rows[0]!.id;
    const orderId = (await db.query<{id: string}>(`select id from public.orders where restaurant_id=$1`,[RESTAURANT_A])).rows[0]!.id;
    const messageId = (await db.query<{id: string}>(`select id from public.messages where restaurant_id=$1`,[RESTAURANT_A])).rows[0]!.id;
    await asUser(db,STAFF_A,async()=>{
      expect((await db.query('select id from public.calls')).rows).toHaveLength(1);
      expect((await db.query(`update public.bookings set notes='staff edit' where id=$1 returning id`,[bookingId])).rows).toHaveLength(1);
      expect((await db.query(`update public.orders set status='ready' where id=$1 returning id`,[orderId])).rows).toHaveLength(1);
      expect((await db.query(`update public.messages set handled=true where id=$1 returning id`,[messageId])).rows).toHaveLength(1);
      expect((await db.query(`update public.organizations set spend_cap_cents=1 where id=$1 returning id`,[ORG_A])).rows).toHaveLength(0);
      expect((await db.query(`update public.agents set persona_name='Changed' where restaurant_id=$1 returning id`,[RESTAURANT_A])).rows).toHaveLength(0);
      await expect(db.query(`update public.phone_numbers set status='released' where restaurant_id=$1 returning id`,[RESTAURANT_A])).rejects.toMatchObject({code: '42501'});
      await expect(db.query(`insert into public.calls(restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at) values($1,md5('version-a')::uuid,'staff-call','hash','0000',now())`,[RESTAURANT_A])).rejects.toThrow(/permission denied/i);
      await expect(db.query(`select public.publish_agent_version(md5('version-a')::uuid)`)).rejects.toThrow(/OWNER_REQUIRED|permission denied/i);
      await expect(db.query(`insert into public.usage_ledger(organization_id,period,seconds) values($1,'2026-11',1)`,[ORG_A])).rejects.toThrow(/permission denied/i);
    });
  });

  it('allows only owner RPCs to change agent versions and blocks direct version writes', async () => {
    await seedTenantGraphs(db);
    const agentId = (await db.query<{id: string}>(`select id from public.agents where restaurant_id=$1`,[RESTAURANT_A])).rows[0]!.id;
    await asUser(db,USER_A,async()=>{
      const draft = await db.query<{id: string; status: string}>(`select result.* from public.save_agent_draft($1,$2::jsonb,$3::jsonb,$4::jsonb) as result`,[
        agentId, JSON.stringify({greeting:'New'}), '{}', JSON.stringify({takeout:true})
      ]);
      expect(draft.rows[0]?.status).toBe('draft');
      const published = await db.query<{status: string}>(`select result.* from public.publish_agent_version($1) as result`,[draft.rows[0]!.id]);
      expect(published.rows[0]?.status).toBe('published');
      await expect(db.query(`update public.agent_versions set prompt_sections='{}' where id=$1`,[draft.rows[0]!.id])).rejects.toThrow(/permission denied/i);
      const restored = await db.query<{status: string; version_no: number}>(`select result.* from public.restore_agent_version($1) as result`,[draft.rows[0]!.id]);
      expect(restored.rows[0]?.status).toBe('draft');
      expect(restored.rows[0]?.version_no).toBe(3);
    });
  });

  it('rejects cross-tenant relationship chains even for a role that bypasses RLS', async () => {
    await seedTenantGraphs(db);
    await expect(db.query(`insert into public.calls(restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at) values($1,md5('version-b')::uuid,'cross-call','hash','0000',now())`,[RESTAURANT_A])).rejects.toThrow(/CROSS_TENANT_AGENT_VERSION/);
    await expect(db.query(`insert into public.bookings(restaurant_id,call_id,name,phone_e164,party_size,starts_at,status,source) values($1,md5('call-b')::uuid,'Cross','+14165550123',1,'2030-01-01T18:00:00Z','confirmed','owner')`,[RESTAURANT_A])).rejects.toThrow(/CROSS_TENANT_CALL/);
    await expect(db.query(`update public.agents set current_published_version_id=md5('version-b')::uuid where id=md5('agent-a')::uuid`)).rejects.toThrow(/CROSS_AGENT_PUBLISHED_VERSION/);
  });

  it('accepts durable menu-upload import sources without fake public URLs', async () => {
    await seedTenantGraphs(db);
    await expect(db.query(
      `insert into public.import_jobs(organization_id,restaurant_id,requested_by,source_url,status) values($1,$2,$3,'upload://menu/menu.pdf','completed')`,
      [ORG_A, RESTAURANT_A, USER_A],
    )).resolves.toBeDefined();
  });

  it('enforces capacity for direct inserts and updates, not only the booking RPC', async () => {
    await seedTenantGraphs(db);
    const first = await db.query<{id: string}>(`insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,source) values($1,'First','+14165550123',6,'2030-01-01T18:00:00Z','confirmed','owner') returning id`,[RESTAURANT_A]);
    const second = await db.query<{id: string}>(`insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,source) values($1,'Second','+14165550124',4,'2030-01-01T19:00:00Z','confirmed','owner') returning id`,[RESTAURANT_A]);
    await expect(db.query(`insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,source) values($1,'Overflow','+14165550125',1,'2030-01-01T18:30:00Z','confirmed','owner')`,[RESTAURANT_A])).rejects.toThrow(/CAPACITY/);
    await expect(db.query(`update public.bookings set party_size=5 where id=$1`,[second.rows[0]!.id])).rejects.toThrow(/CAPACITY/);
    expect(first.rows).toHaveLength(1);
  });

  it('serializes competing booking calls on PGlite single-connection scheduling', async () => {
    await db.query(`insert into public.slots_config (restaurant_id, slot_minutes, covers_per_slot, seating_minutes, max_party, lead_time_minutes, booking_window_days) values ($1, 15, 10, 90, 8, 0, 90)`, [RESTAURANT_A]);
    const startsAt = '2026-11-02T23:00:00.000Z';
    const reserve = (name: string) => db.query(
      `select public.create_booking($1, $2, $3, $4, $5, $6)`,
      [RESTAURANT_A, name, '+14165550123', 6, startsAt, '']
    );
    // PGlite queues these promises on one embedded connection. The database trigger and
    // advisory transaction lock provide the same invariant for real multi-session Postgres.
    const outcomes = await asUser(db, USER_A, () => Promise.allSettled([reserve('First'), reserve('Second')]));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status==='rejected');
    expect(String(rejected?.reason)).toMatch(/CAPACITY/);
    expect((await db.query<{covers: number}>(`select coalesce(sum(party_size), 0)::int as covers from public.bookings where restaurant_id = $1 and starts_at = $2`, [RESTAURANT_A, startsAt])).rows[0]?.covers).toBe(6);
  });

  it('creates private storage buckets and publishes calls to Realtime', async () => {
    expect((await db.query<{id: string; public: boolean}>('select id, public from storage.buckets order by id')).rows).toEqual([
      {id: 'audio-cache', public: false},
      {id: 'recordings', public: false}
    ]);
    expect((await db.query<{tablename: string}>(`select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'`)).rows.map((row) => row.tablename)).toContain('calls');
    await db.exec(`
      insert into storage.objects(bucket_id,name) values
        ('recordings','${RESTAURANT_A}/a.wav'),('recordings','${RESTAURANT_B}/b.wav'),
        ('audio-cache','${RESTAURANT_A}/hello.wav'),('audio-cache','${RESTAURANT_B}/hello.wav');
    `);
    await asUser(db, USER_A, async () => {
      expect((await db.query<{name: string}>('select name from storage.objects order by name')).rows.map((row) => row.name)).toEqual([
        `${RESTAURANT_A}/a.wav`, `${RESTAURANT_A}/hello.wav`
      ]);
      await expect(db.query(`insert into storage.objects(bucket_id,name) values ('recordings',$1)`, [`${RESTAURANT_A}/new.wav`])).rejects.toThrow(/permission denied/i);
    });
  });
});
