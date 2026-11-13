import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';

import {asUser, createDatabase} from './database';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const organizationId = '10000000-0000-4000-8000-000000000001';
const restaurantId = '20000000-0000-4000-8000-000000000002';
const orderId = '30000000-0000-4000-8000-000000000003';
const bookingId = '40000000-0000-4000-8000-000000000004';

describe('diner payment persistence', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createDatabase();
    await db.exec(`
      insert into auth.users(id) values ('${ownerId}');
      insert into public.organizations(id,name,plan,spend_cap_cents) values ('${organizationId}','Group','starter',2000);
      insert into public.memberships(organization_id,user_id,role) values ('${organizationId}','${ownerId}','owner');
      insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status,stripe_connected_account_id,booking_deposit_cents)
      values ('${restaurantId}','${organizationId}','Restaurant','1 Main','ON','America/Toronto','en',array['en'],'live',null,2500);
      update public.restaurants set stripe_connected_account_id='acct_restaurant' where id='${restaurantId}';
      insert into public.orders(id,restaurant_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,paid_status,status)
      values ('${orderId}','${restaurantId}','Order','+14165550101',now(),1000,130,1130,'unpaid','new');
      insert into public.slots_config(restaurant_id,slot_minutes,covers_per_slot,seating_minutes,max_party,lead_time_minutes,booking_window_days)
      values ('${restaurantId}',15,20,90,8,0,90);
      insert into public.bookings(id,restaurant_id,name,phone_e164,party_size,starts_at,status,notes,source)
      values ('${bookingId}','${restaurantId}','Guest','+14165550102',2,now()+interval '1 day','confirmed','','owner');
    `);
  });

  afterEach(async () => db.close());

  it('marks order and booking paid idempotently only through the connected account mapping', async () => {
    const order = await db.query<{result: string}>(
      `select public.apply_connected_payment_event('acct_restaurant','order',$1) as result`, [orderId],
    );
    const duplicate = await db.query<{result: string}>(
      `select public.apply_connected_payment_event('acct_restaurant','order',$1) as result`, [orderId],
    );
    const booking = await db.query<{result: string}>(
      `select public.apply_connected_payment_event('acct_restaurant','booking',$1) as result`, [bookingId],
    );
    const unknown = await db.query<{result: string}>(
      `select public.apply_connected_payment_event('acct_unknown','order',$1) as result`, [orderId],
    );

    expect(order.rows[0]?.result).toBe('applied');
    expect(duplicate.rows[0]?.result).toBe('stale');
    expect(booking.rows[0]?.result).toBe('applied');
    expect(unknown.rows[0]?.result).toBe('not_found');
    expect((await db.query<{paid_status: string}>('select paid_status from public.bookings where id=$1', [bookingId])).rows[0]?.paid_status).toBe('paid');

    await db.query(`update public.orders set paid_status='unpaid' where id=$1`, [orderId]);
    await db.query(`update public.restaurants set stripe_connected_account_id=null where id=$1`, [restaurantId]);
    const afterDisconnect = await db.query<{result: string}>(
      `select public.apply_connected_payment_event('acct_restaurant','order',$1) as result`, [orderId],
    );
    expect(afterDisconnect.rows[0]?.result).toBe('applied');
  });

  it('prevents authenticated owners from forging connected-account IDs or paid status', async () => {
    await asUser(db, ownerId, async () => {
      await expect(db.query(`update public.restaurants set stripe_connected_account_id='acct_attacker' where id=$1`, [restaurantId]))
        .rejects.toMatchObject({code: '42501'});
      await expect(db.query(`update public.orders set paid_status='paid' where id=$1`, [orderId]))
        .rejects.toMatchObject({code: '42501'});
      await expect(db.query(`update public.bookings set paid_status='paid' where id=$1`, [bookingId]))
        .rejects.toMatchObject({code: '42501'});
      await expect(db.query(`insert into public.restaurants(organization_id,name,address,province,timezone,primary_language,enabled_languages,status,stripe_connected_account_id)
        values ($1,'Forged','2 Main','ON','America/Toronto','en',array['en'],'draft','acct_attacker')`, [organizationId]))
        .rejects.toMatchObject({code: '42501'});
      await expect(db.query(`insert into public.orders(restaurant_id,name,phone,pickup_at,subtotal_cents,tax_cents,total_cents,paid_status,status)
        values ($1,'Forged','+14165550103',now(),100,13,113,'paid','new')`, [restaurantId]))
        .rejects.toMatchObject({code: '42501'});
      await expect(db.query(`insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,notes,source,paid_status)
        values ($1,'Forged','+14165550104',2,now()+interval '2 day','confirmed','','owner','paid')`, [restaurantId]))
        .rejects.toMatchObject({code: '42501'});
    });
  });
});
