import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {createDatabase} from '../db/database';

describe('API route migration', () => {
  let db: PGlite;
  beforeEach(async () => { db = await createDatabase(); });
  afterEach(async () => db.close());

  it('creates import job and processed event persistence with uniqueness', async () => {
    const tables = await db.query<{table_name: string}>(`select table_name from information_schema.tables where table_schema='public' and table_name in ('import_jobs','import_review_rows','processed_events') order by table_name`);
    expect(tables.rows.map((row) => row.table_name)).toEqual(['import_jobs', 'import_review_rows', 'processed_events']);
    await db.query(`insert into public.processed_events(provider,event_id,status) values('stripe','evt_1','processing')`);
    await expect(db.query(`insert into public.processed_events(provider,event_id,status) values('stripe','evt_1','processing')`)).rejects.toThrow(/unique constraint|duplicate key/i);
  });

  it('keeps usage alert idempotency service-role only', async () => {
    const organizationId = '10000000-0000-4000-8000-000000000099';
    await db.query(`insert into public.organizations(id,name,plan,spend_cap_cents) values($1,'Alerts','starter',2000)`, [organizationId]);
    await db.query(`insert into public.usage_alerts_sent(organization_id,period,threshold) values($1,'2026-10','80')`, [organizationId]);
    await expect(db.query(`insert into public.usage_alerts_sent(organization_id,period,threshold) values($1,'2026-10','80')`, [organizationId])).rejects.toThrow(/unique constraint|duplicate key/i);
    await db.exec(`set role authenticated`);
    await expect(db.query(`select * from public.usage_alerts_sent`)).rejects.toThrow(/permission denied/i);
    await expect(db.query(`insert into public.usage_alerts_sent(organization_id,period,threshold) values($1,'2026-10','100')`, [organizationId])).rejects.toThrow(/permission denied/i);
    await db.exec(`reset role`);
  });

  it('tracks the cumulative seconds already accepted by the Stripe meter', async () => {
    const columns = await db.query<{column_name: string}>(`select column_name from information_schema.columns where table_schema='public' and table_name='usage_ledger'`);
    expect(columns.rows.map((row) => row.column_name)).toContain('reported_seconds');
  });

  it('finalizes a staged usage batch without overwriting a newer call total', async () => {
    const organizationId = '10000000-0000-4000-8000-000000000098';
    await db.query(`insert into public.organizations(id,name,plan,spend_cap_cents) values($1,'Meter','starter',2000)`, [organizationId]);
    await db.query(`insert into public.usage_ledger(organization_id,period,seconds,stripe_reported,cost_micros) values($1,'2026-10',12,false,0)`, [organizationId]);
    const claimed = await db.query<{claim_usage_report: {identifier: string; targetSeconds: number; reportedSeconds: number}}>(
      `select public.claim_usage_report($1,'2026-10',12,'usage:batch-a')`, [organizationId],
    );
    expect(claimed.rows[0]?.claim_usage_report).toEqual({identifier: 'usage:batch-a', targetSeconds: 12, reportedSeconds: 0});
    await db.query(`update public.usage_ledger set seconds=18,stripe_reported=false where organization_id=$1 and period='2026-10'`, [organizationId]);
    await db.query(`select public.complete_usage_report($1,'2026-10','usage:batch-a')`, [organizationId]);
    const ledger = await db.query<{seconds: number; reported_seconds: number; stripe_reported: boolean; reporting_identifier: string | null}>(
      `select seconds,reported_seconds,stripe_reported,reporting_identifier from public.usage_ledger where organization_id=$1 and period='2026-10'`, [organizationId],
    );
    expect(ledger.rows[0]).toEqual({seconds: 18, reported_seconds: 12, stripe_reported: false, reporting_identifier: null});
  });

  it('adds provider identifiers required for delivery receipt correlation', async () => {
    const columns = await db.query<{column_name: string}>(`select column_name from information_schema.columns where table_schema='public' and table_name='sms_log'`);
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(['provider_message_id', 'last_event_at', 'delivery_error']));
  });

  it('atomically reclaims only failed webhook events', async () => {
    expect((await db.query<{claim_processed_event: boolean}>(
      `select public.claim_processed_event('stripe','evt_retry')`,
    )).rows[0]?.claim_processed_event).toBe(true);
    expect((await db.query<{claim_processed_event: boolean}>(
      `select public.claim_processed_event('stripe','evt_retry')`,
    )).rows[0]?.claim_processed_event).toBe(false);
    await db.query(`update public.processed_events set status='failed' where provider='stripe' and event_id='evt_retry'`);
    expect((await db.query<{claim_processed_event: boolean}>(
      `select public.claim_processed_event('stripe','evt_retry')`,
    )).rows[0]?.claim_processed_event).toBe(true);
    await db.query(`update public.processed_events set claimed_at=now()-interval '6 minutes'
      where provider='stripe' and event_id='evt_retry'`);
    expect((await db.query<{claim_processed_event: boolean}>(
      `select public.claim_processed_event('stripe','evt_retry')`,
    )).rows[0]?.claim_processed_event).toBe(true);
  });

  it('leases extraction and atomically replaces review rows', async () => {
    const organizationId = '10000000-0000-4000-8000-000000000011';
    const restaurantId = '20000000-0000-4000-8000-000000000012';
    const jobId = '30000000-0000-4000-8000-000000000013';
    await db.query(`insert into public.organizations(id,name,plan,spend_cap_cents)
      values($1,'Test','starter',2000)`, [organizationId]);
    await db.query(`insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status)
      values($1,$2,'Test','1 Test St','ON','America/Toronto','en',array['en'],'draft')`, [restaurantId, organizationId]);
    await db.query(`insert into public.import_jobs(id,organization_id,restaurant_id,source_url,status)
      values($1,$2,$3,'https://example.com','processing')`, [jobId, organizationId, restaurantId]);
    expect((await db.query<{claim_import_extraction: boolean}>(
      `select public.claim_import_extraction($1)`, [jobId],
    )).rows[0]?.claim_import_extraction).toBe(true);
    expect((await db.query<{claim_import_extraction: boolean}>(
      `select public.claim_import_extraction($1)`, [jobId],
    )).rows[0]?.claim_import_extraction).toBe(false);
    const rows = JSON.stringify([{job_id: jobId, restaurant_id: restaurantId, kind: 'menu', payload: {name: 'Soup'}, status: 'pending'}]);
    await db.query(`select public.replace_import_review_rows($1,$2,$3::jsonb)`, [jobId, restaurantId, rows]);
    await db.query(`select public.replace_import_review_rows($1,$2,$3::jsonb)`, [jobId, restaurantId, rows]);
    expect((await db.query<{count: number}>(
      `select count(*)::int count from public.import_review_rows where job_id=$1`, [jobId],
    )).rows[0]?.count).toBe(1);
  });

  it('rejects stale Stripe and SMS state transitions in the database', async () => {
    const organizationId = '10000000-0000-4000-8000-000000000001';
    const restaurantId = '20000000-0000-4000-8000-000000000002';
    await db.query(`insert into public.organizations(id,name,plan,spend_cap_cents,stripe_customer_id)
      values($1,'Test','starter',2000,'cus_1')`, [organizationId]);
    await db.query(`insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status)
      values($1,$2,'Test','1 Test St','ON','America/Toronto','en',array['en'],'draft')`, [restaurantId, organizationId]);
    expect((await db.query<{apply_stripe_billing_event: string}>(
      `select public.apply_stripe_billing_event('cus_1',null,'subscription','2026-10-27T12:00:00Z',
       '{"stripe_subscription_status":"active","stripe_subscription_event_id":"evt_z"}'::jsonb)`,
    )).rows[0]?.apply_stripe_billing_event).toBe('applied');
    expect((await db.query<{apply_stripe_billing_event: string}>(
      `select public.apply_stripe_billing_event('cus_1',null,'subscription','2026-10-27T11:59:59Z',
       '{"stripe_subscription_status":"past_due","stripe_subscription_event_id":"evt_b"}'::jsonb)`,
    )).rows[0]?.apply_stripe_billing_event).toBe('stale');
    expect((await db.query<{stripe_subscription_status: string}>(
      `select stripe_subscription_status from public.organizations where id=$1`, [organizationId],
    )).rows[0]?.stripe_subscription_status).toBe('active');
    expect((await db.query<{apply_stripe_billing_event: string}>(
      `select public.apply_stripe_billing_event('cus_1',null,'subscription','2026-10-27T12:00:00Z',
       '{"stripe_subscription_status":"past_due","stripe_subscription_event_id":"evt_a"}'::jsonb)`,
    )).rows[0]?.apply_stripe_billing_event).toBe('stale');

    await db.query(`insert into public.sms_log(restaurant_id,to_e164,body,status,provider_message_id)
      values($1,'+14165550123','test','queued','msg_1')`, [restaurantId]);
    expect((await db.query<{apply_sms_delivery_event: string}>(
      `select public.apply_sms_delivery_event('msg_1','delivered','2026-10-27T12:00:00Z',null)`,
    )).rows[0]?.apply_sms_delivery_event).toBe('applied');
    expect((await db.query<{apply_sms_delivery_event: string}>(
      `select public.apply_sms_delivery_event('msg_1','sent','2026-10-27T11:59:59Z',null)`,
    )).rows[0]?.apply_sms_delivery_event).toBe('stale');
    expect((await db.query<{status: string}>(
      `select status from public.sms_log where provider_message_id='msg_1'`,
    )).rows[0]?.status).toBe('delivered');
  });
});
