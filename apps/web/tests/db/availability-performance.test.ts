import {expect, test} from 'vitest';
import {performance} from 'node:perf_hooks';
import {createDatabase} from './database';

const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const RESTAURANT_ID = '30000000-0000-4000-8000-000000000003';

function p95(samples: number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]!;
}

test('PGlite SQL availability function stays under 150 ms p95 with 1,000 month bookings', async () => {
  const db = await createDatabase();
  try {
    await db.exec(`
      insert into public.organizations(id,name,plan,spend_cap_cents)
      values('${ORGANIZATION_ID}','Performance fixture','starter',2000);
      insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status)
      values('${RESTAURANT_ID}','${ORGANIZATION_ID}','Performance fixture','1 Test St','ON','America/Toronto','en',array['en'],'live');
      insert into public.slots_config(restaurant_id,slot_minutes,covers_per_slot,seating_minutes,max_party,lead_time_minutes,booking_window_days)
      values('${RESTAURANT_ID}',15,10000,90,20,0,90);
      insert into public.bookings(restaurant_id,name,phone_e164,party_size,starts_at,status,source)
      select '${RESTAURANT_ID}', 'Guest ' || value, '+14165550123', (value % 6) + 1,
        timestamptz '2026-11-01 17:00:00+00' + (value % 30) * interval '1 day' + (value % 28) * interval '15 minutes',
        'confirmed', 'owner'
      from generate_series(1,1000) value;
    `);
    const query = () => db.query<{available: boolean}>(
      'select public.check_availability($1,$2,$3) as available',
      [RESTAURANT_ID, '2026-11-15T23:00:00.000Z', 4],
    );
    for (let index = 0; index < 10; index += 1) await query();
    const samples: number[] = [];
    for (let index = 0; index < 200; index += 1) {
      const started = performance.now();
      const result = await query();
      samples.push(performance.now() - started);
      expect(typeof result.rows[0]?.available).toBe('boolean');
    }
    const measured = p95(samples);
    console.info(`F9 PGlite SQL availability: p95=${measured.toFixed(3)} ms over 200 runs`);
    expect(measured).toBeLessThan(150);
  } finally {
    await db.close();
  }
}, 30_000);
