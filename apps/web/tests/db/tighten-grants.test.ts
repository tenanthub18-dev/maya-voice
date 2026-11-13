import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';
import {asUser, createDatabase} from './database';

const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const RESTAURANT_ID = '20000000-0000-4000-8000-000000000002';

async function expectSqlState(operation: Promise<unknown>, code: string): Promise<void> {
  await expect(operation).rejects.toMatchObject({code});
}

describe('tightened authenticated database grants', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createDatabase();
    await db.exec(`
      insert into auth.users(id) values ('${OWNER_ID}'), ('${STAFF_ID}');
      insert into public.organizations(id,name,plan,spend_cap_cents,stripe_customer_id)
      values ('${ORGANIZATION_ID}','Original name','starter',2000,'cus_original');
      insert into public.memberships(organization_id,user_id,role) values
        ('${ORGANIZATION_ID}','${OWNER_ID}','owner'),
        ('${ORGANIZATION_ID}','${STAFF_ID}','staff');
      insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status)
      values ('${RESTAURANT_ID}','${ORGANIZATION_ID}','Restaurant','1 Main St','ON','America/Toronto','en',array['en'],'live');
      insert into public.phone_numbers(restaurant_id,e164,telnyx_number_id,status)
      values ('${RESTAURANT_ID}','+14165550101','telnyx-original','active');
      insert into public.sms_optouts(restaurant_id,phone_e164)
      values ('${RESTAURANT_ID}','+14165550102');
      insert into public.slots_config(restaurant_id,slot_minutes,covers_per_slot,seating_minutes,max_party,lead_time_minutes,booking_window_days)
      values ('${RESTAURANT_ID}',15,20,90,8,0,90);
    `);
  });

  afterEach(async () => db.close());

  it('allows owners to update only organization name and spend cap', async () => {
    await asUser(db, OWNER_ID, async () => {
      await expectSqlState(db.query(`update public.organizations set plan='growth' where id=$1`, [ORGANIZATION_ID]), '42501');
      await expectSqlState(db.query(`update public.organizations set stripe_customer_id='cus_attacker' where id=$1`, [ORGANIZATION_ID]), '42501');

      expect((await db.query(`update public.organizations set name='Safer name' where id=$1 returning id`, [ORGANIZATION_ID])).rows).toHaveLength(1);
      expect((await db.query(`update public.organizations set spend_cap_cents=3500 where id=$1 returning id`, [ORGANIZATION_ID])).rows).toHaveLength(1);
    });
  });

  it('makes phone numbers read-only for authenticated owners', async () => {
    await asUser(db, OWNER_ID, async () => {
      expect((await db.query('select id from public.phone_numbers')).rows).toHaveLength(1);
      await expectSqlState(db.query(
        `insert into public.phone_numbers(restaurant_id,e164,telnyx_number_id,status) values($1,'+14165550199','telnyx-other','active')`,
        [RESTAURANT_ID],
      ), '42501');
      await expectSqlState(db.query(
        'update public.phone_numbers set forwarding_verified_at=now() where restaurant_id=$1',
        [RESTAURANT_ID],
      ), '42501');
      await expectSqlState(db.query('delete from public.phone_numbers where restaurant_id=$1', [RESTAURANT_ID]), '42501');
    });
  });

  it('makes SMS opt-outs read-only for authenticated owners', async () => {
    await asUser(db, OWNER_ID, async () => {
      expect((await db.query('select id from public.sms_optouts')).rows).toHaveLength(1);
      await expectSqlState(db.query(
        `insert into public.sms_optouts(restaurant_id,phone_e164) values($1,'+14165550103')`,
        [RESTAURANT_ID],
      ), '42501');
      await expectSqlState(db.query(
        `update public.sms_optouts set phone_e164='+14165550104' where restaurant_id=$1`,
        [RESTAURANT_ID],
      ), '42501');
      await expectSqlState(db.query('delete from public.sms_optouts where restaurant_id=$1', [RESTAURANT_ID]), '42501');
    });
  });

  it('accepts only owner, staff, phone, and web booking sources and defaults to owner', async () => {
    await asUser(db, OWNER_ID, async () => {
      const defaulted = await db.query<{source: string}>(
        'select source from public.create_booking($1,$2,$3,$4,$5,$6)',
        [RESTAURANT_ID, 'Default owner', '+14165550201', 1, '2030-01-01T17:00:00Z', ''],
      );
      expect(defaulted.rows[0]?.source).toBe('owner');

      for (const [index, source] of ['owner', 'staff', 'phone', 'web'].entries()) {
        const booking = await db.query<{source: string}>(
          'select source from public.create_booking($1,$2,$3,$4,$5,$6,$7)',
          [RESTAURANT_ID, source, `+1416555021${index}`, 1, `2030-01-0${index + 2}T17:00:00Z`, '', source],
        );
        expect(booking.rows[0]?.source).toBe(source);
      }

      await expectSqlState(db.query(
        'select source from public.create_booking($1,$2,$3,$4,$5,$6,$7)',
        [RESTAURANT_ID, 'Invalid', '+14165550299', 1, '2030-01-10T17:00:00Z', '', 'forged'],
      ), '23514');
    });
  });
});
