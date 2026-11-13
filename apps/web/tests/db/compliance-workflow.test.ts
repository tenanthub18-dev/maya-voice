import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';

import {asUser, createDatabase} from './database';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationId = '10000000-0000-4000-8000-000000000001';
const restaurantId = '30000000-0000-4000-8000-000000000003';
const phone = '+14165550123';
const phoneHash = 'a'.repeat(64);

describe('compliance persistence workflow', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createDatabase();
    await db.exec(`
      insert into auth.users(id) values ('${userId}');
      insert into public.organizations(id,name,plan,spend_cap_cents) values ('${organizationId}','Test','starter',2000);
      insert into public.memberships(organization_id,user_id,role) values ('${organizationId}','${userId}','owner');
      insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status)
      values ('${restaurantId}','${organizationId}','Test','1 Test St','QC','America/Toronto','fr-CA',array['fr-CA'],'live');
      insert into public.slots_config(restaurant_id,slot_minutes,covers_per_slot,seating_minutes,max_party,lead_time_minutes,booking_window_days)
      values ('${restaurantId}',15,20,90,10,0,90);
    `);
  });

  afterEach(async () => db.close());

  it('persists the Quebec default notice French-first', async () => {
    const notice = (await db.query<{recording_notice: string}>(
      'select recording_notice from public.legal_settings where restaurant_id=$1', [restaurantId],
    )).rows[0]?.recording_notice;

    expect(notice).toMatch(/^Cet appel peut être enregistré[\s\S]+This call may be recorded/u);
  });

  it('reorders a customized valid notice when the province changes', async () => {
    await db.query(`update public.legal_settings set recording_notice=recording_notice || E'\n\nCustom restaurant sentence.' where restaurant_id=$1`, [restaurantId]);
    await db.query(`update public.restaurants set province='ON' where id=$1`, [restaurantId]);
    const notice = (await db.query<{recording_notice: string}>('select recording_notice from public.legal_settings where restaurant_id=$1', [restaurantId])).rows[0]!.recording_notice;
    expect(notice).toMatch(/^This call may be recorded[\s\S]+Cet appel peut être enregistré[\s\S]+Custom restaurant sentence/u);
  });

  it('keeps raw compliance rows private while narrow legal RPCs persist independent controls', async () => {
    await asUser(db, userId, async () => {
      await expect(db.query('select * from public.privacy_requests')).rejects.toThrow(/permission denied/u);
      await expect(db.query('select * from public.legal_settings')).rejects.toThrow(/permission denied/u);
      const current = (await db.query<{recording_notice: string}>('select (public.get_legal_settings()).recording_notice')).rows[0]!.recording_notice;
      await db.query('select public.update_legal_settings($1,false,true)', [current]);
      const updated = (await db.query<{recording_enabled: boolean; transcript_enabled: boolean}>('select (public.get_legal_settings()).recording_enabled,(public.get_legal_settings()).transcript_enabled')).rows[0]!;
      expect(updated).toEqual({recording_enabled: false, transcript_enabled: true});
    });
  });

  it('requires verification, returns an export, and keeps the full phone out of audit events', async () => {
    await db.query(`insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,source)
      values($1,'Caller',$2,2,now()+interval '1 day','confirmed','owner')`, [restaurantId, phone]);
    const orderId = '40000000-0000-4000-8000-000000000004';
    await db.query(`insert into public.orders(id,restaurant_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,paid_status,status)
      values($1,$2,'Caller',$3,now(),1000,130,1130,'paid','ready')`, [orderId, restaurantId, phone]);
    await db.query(`insert into public.order_items(order_id,item,quantity,price_cents) values($1,'Soup',1,1000)`, [orderId]);
    await db.query(`insert into public.sms_log(restaurant_id,to_e164,body,status) values($1,$2,'Receipt','delivered')`, [restaurantId, phone]);
    const created = await db.query<{id: string}>(`
      select (public.create_privacy_request($1,$2,$3,'export',$4,'0123')).id
    `, [userId, organizationId, restaurantId, phoneHash]);
    const requestId = created.rows[0]!.id;
    const dueAt = (await db.query<{days: number}>('select extract(day from due_at-created_at)::int days from public.privacy_requests where id=$1', [requestId])).rows[0]?.days;
    expect(dueAt).toBe(30);

    await expect(db.query(`select public.transition_privacy_request($1,$2,$3,'fulfill',null)`, [userId, organizationId, requestId]))
      .rejects.toThrow(/PRIVACY_REQUEST_NOT_VERIFIED/u);
    await db.query(`select public.transition_privacy_request($1,$2,$3,'verify',null,'callback','case-1234')`, [userId, organizationId, requestId]);
    await db.query(`select public.prepare_privacy_request_fulfillment($1,$2,$3)`, [userId, organizationId, requestId]);
    await db.query(`select public.transition_privacy_request($1,$2,$3,'fulfill',null,null,null,$4,$5)`, [userId, organizationId, requestId, phone, phoneHash]);

    const record = (await db.query<{status: string; result: Record<string, unknown[]>}>(
      'select status,result from public.privacy_requests where id=$1', [requestId],
    )).rows[0]!;
    expect(record.status).toBe('completed');
    expect(record.result.bookings).toHaveLength(1);
    expect(record.result.orders).toHaveLength(1);
    expect(record.result.orderItems).toHaveLength(1);
    expect(record.result.smsLog).toHaveLength(1);
    expect(record.result).toMatchObject({calls: [], callTurns: [], callMetrics: [], toolInvocations: [], smsOptOuts: []});
    const audit = await db.query<{entry: string}>(`select target || reason entry from public.audit_log where target like $1`, [`privacy-request:${requestId}:%`]);
    expect(audit.rows).toHaveLength(4);
    expect(JSON.stringify(audit.rows)).not.toContain(phone);
    await db.query(`update public.privacy_requests set result_expires_at=now()-interval '1 second' where id=$1`, [requestId]);
    expect((await db.query<{purged: number}>('select public.purge_expired_privacy_results() purged')).rows[0]?.purged).toBe(1);
    expect((await db.query<{result: unknown}>('select result from public.privacy_requests where id=$1', [requestId])).rows[0]?.result).toBeNull();
  });

  it('deletes caller records while retaining redacted order totals', async () => {
    await db.query(`insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,source)
      values($1,'Caller',$2,2,now()+interval '1 day','confirmed','owner')`, [restaurantId, phone]);
    await db.query(`insert into public.orders(restaurant_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,paid_status,status)
      values($1,'Caller',$2,now(),1000,130,1130,'paid','ready')`, [restaurantId, phone]);
    await db.query(`insert into public.messages(restaurant_id,caller_name,phone,text) values($1,'Caller',$2,'Private')`, [restaurantId, phone]);
    await db.query(`insert into public.sms_optouts(restaurant_id,phone_e164) values($1,$2)`, [restaurantId, phone]);
    const requestId = (await db.query<{id: string}>(`
      select (public.create_privacy_request($1,$2,$3,'delete',$4,'0123')).id
    `, [userId, organizationId, restaurantId, phoneHash])).rows[0]!.id;
    await db.query(`select public.transition_privacy_request($1,$2,$3,'verify',null,'callback','case-1234')`, [userId, organizationId, requestId]);
    await db.query(`select public.prepare_privacy_request_fulfillment($1,$2,$3)`, [userId, organizationId, requestId]);
    expect((await db.query<{status: string}>('select status from public.privacy_requests where id=$1', [requestId])).rows[0]?.status).toBe('fulfilling');
    await db.query(`select public.prepare_privacy_request_fulfillment($1,$2,$3)`, [userId, organizationId, requestId]);
    await db.query(`select public.transition_privacy_request($1,$2,$3,'fulfill',null,null,null,$4,$5)`, [userId, organizationId, requestId, phone, phoneHash]);

    expect((await db.query<{count: number}>('select count(*)::int count from public.bookings')).rows[0]?.count).toBe(0);
    expect((await db.query<{count: number}>('select count(*)::int count from public.messages')).rows[0]?.count).toBe(0);
    expect((await db.query<{count: number}>('select count(*)::int count from public.sms_optouts')).rows[0]?.count).toBe(1);
    expect((await db.query<{name: string; phone: string; total_cents: number}>('select name,phone,total_cents from public.orders')).rows[0])
      .toEqual({name: 'Deleted caller', phone: '', total_cents: 1130});
  });

  it('blocks completion until a late recording path is removed on retry', async () => {
    await db.exec(`
      insert into public.agents(id,restaurant_id,persona_name,filler_level) values(md5('agent')::uuid,'${restaurantId}','A','none');
      insert into public.agent_versions(id,agent_id,version_no,status) values(md5('version')::uuid,md5('agent')::uuid,1,'published');
      insert into public.calls(id,restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at,outcome)
      values(md5('call')::uuid,'${restaurantId}',md5('version')::uuid,'call-late','${phoneHash}','0123',now(),'answered');
    `);
    const requestId = (await db.query<{id: string}>(`
      select (public.create_privacy_request($1,$2,$3,'delete',$4,'0123')).id
    `, [userId, organizationId, restaurantId, phoneHash])).rows[0]!.id;
    await db.query(`select public.transition_privacy_request($1,$2,$3,'verify',null,'callback','case-late')`, [userId, organizationId, requestId]);
    await db.query(`select public.prepare_privacy_request_fulfillment($1,$2,$3)`, [userId, organizationId, requestId]);
    await db.query(`update public.calls set recording_path='${restaurantId}/late.wav' where telnyx_call_id='call-late'`);
    await expect(db.query(
      `select public.transition_privacy_request($1,$2,$3,'fulfill',null,null,null,$4,$5,array[]::text[])`,
      [userId, organizationId, requestId, phone, phoneHash],
    )).rejects.toThrow(/PRIVACY_REQUEST_RECORDINGS_PENDING/u);
    expect((await db.query<{recording_path: string}>('select recording_path from public.calls where telnyx_call_id=$1', ['call-late'])).rows[0]?.recording_path)
      .toBe(`${restaurantId}/late.wav`);
    const prepared = (await db.query<{value: {recording_paths: string[]}}>(
      `select public.prepare_privacy_request_fulfillment($1,$2,$3) value`, [userId, organizationId, requestId],
    )).rows[0]!.value;
    expect(prepared.recording_paths).toEqual([`${restaurantId}/late.wav`]);
    await db.query(
      `select public.transition_privacy_request($1,$2,$3,'fulfill',null,null,null,$4,$5,$6::text[])`,
      [userId, organizationId, requestId, phone, phoneHash, [`${restaurantId}/late.wav`]],
    );
    expect((await db.query<{recording_path: string | null}>('select recording_path from public.calls where telnyx_call_id=$1', ['call-late'])).rows[0]?.recording_path)
      .toBeNull();
  });

  it('plans and dry-runs retention against an injected clock without deleting rows', async () => {
    await db.exec(`
      insert into public.agents(id,restaurant_id,persona_name,filler_level) values(md5('retention-agent')::uuid,'${restaurantId}','A','none');
      insert into public.agent_versions(id,agent_id,version_no,status) values(md5('retention-version')::uuid,md5('retention-agent')::uuid,1,'published');
      insert into public.calls(id,restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at,outcome,recording_path)
      values(md5('retention-call')::uuid,'${restaurantId}',md5('retention-version')::uuid,'call-retention','${phoneHash}','0123','2026-01-01T00:00:00Z','answered','${restaurantId}/old.wav');
      insert into public.call_turns(call_id,idx,speaker,language,text,started_ms,ended_ms)
      values(md5('retention-call')::uuid,0,'caller','en','old transcript',0,100);
      update public.legal_settings set recording_retention_days=90,transcript_retention_days=365 where restaurant_id='${restaurantId}';
    `);
    const clock = '2027-01-02T00:00:00Z';
    const plan = (await db.query<{value: {recordings: number; transcripts: number; recording_paths: string[]}}>(
      'select public.prepare_retention($1) value', [clock],
    )).rows[0]!.value;
    expect(plan).toEqual({recordings: 1, transcripts: 1, recording_paths: [`${restaurantId}/old.wav`]});
    await db.query('select public.execute_retention($1,true,array[]::text[])', [clock]);
    expect((await db.query<{path: string}>('select recording_path path from public.calls where telnyx_call_id=$1', ['call-retention'])).rows[0]?.path)
      .toBe(`${restaurantId}/old.wav`);
    expect((await db.query<{count: number}>('select count(*)::int count from public.call_turns where call_id=md5($1)::uuid', ['retention-call'])).rows[0]?.count).toBe(1);
    expect((await db.query<{count: number}>("select count(*)::int count from public.audit_log where action='retention.dry_run'")).rows[0]?.count).toBe(1);
  });
});
