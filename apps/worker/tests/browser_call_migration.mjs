// Reuse the existing isolated PGlite migration harness; never contacts Supabase.
import assert from 'node:assert/strict';
import {asUser, createDatabase} from '../../web/tests/db/database.ts';

const db = await createDatabase();
try {
  await db.exec(`
    insert into auth.users(id) values(md5('owner-a')::uuid),(md5('owner-b')::uuid);
    insert into public.organizations(id,name,plan,spend_cap_cents) values
      (md5('org-a')::uuid,'A','starter',2000),(md5('org-b')::uuid,'B','starter',2000);
    insert into public.memberships(organization_id,user_id,role) values
      (md5('org-a')::uuid,md5('owner-a')::uuid,'owner'),(md5('org-b')::uuid,md5('owner-b')::uuid,'owner');
    insert into public.restaurants(id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status) values
      (md5('restaurant-a')::uuid,md5('org-a')::uuid,'A','A','ON','America/Toronto','en',array['en'],'draft'),
      (md5('restaurant-b')::uuid,md5('org-b')::uuid,'B','B','ON','America/Toronto','en',array['en'],'draft');
    insert into public.agents(id,restaurant_id,persona_name,filler_level) values
      (md5('agent-a')::uuid,md5('restaurant-a')::uuid,'A','none'),(md5('agent-b')::uuid,md5('restaurant-b')::uuid,'B','none');
    insert into public.agent_versions(id,agent_id,version_no,status) values
      (md5('version-a')::uuid,md5('agent-a')::uuid,1,'draft'),(md5('version-b')::uuid,md5('agent-b')::uuid,1,'draft');
  `);
  // The original telephone identity remains required and unique, old usage unknown.
  const phone = `insert into public.calls(restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at)
    values(md5('restaurant-a')::uuid,md5('version-a')::uuid,'tel-1','hash','1234',now())`;
  await db.exec(phone);
  await assert.rejects(db.exec(phone), /unique|duplicate/i);
  assert.deepEqual((await db.query(`select source,usage from public.calls where telnyx_call_id='tel-1'`)).rows, [{source:'phone',usage:{}}]);
  const browser = `insert into public.calls(source,restaurant_id,agent_version_id,started_at)
    values('browser',md5('restaurant-a')::uuid,md5('version-a')::uuid,now()) returning id`;
  const id = (await db.query(browser)).rows[0].id;
  await db.exec(`insert into public.call_turns(call_id,idx,speaker,language,text,started_ms,ended_ms) values('${id}',0,'caller','en','Hi',0,1)`);
  for (const patch of ["source='invalid'", "source='phone'", "billable_seconds=1", "telnyx_call_id='fake'", "usage='[]'::jsonb"]) {
    await assert.rejects(db.exec(`update public.calls set ${patch} where id='${id}'`), /check constraint/i);
  }
  const ownerA = (await db.query(`select md5('owner-a')::uuid id`)).rows[0].id;
  const ownerB = (await db.query(`select md5('owner-b')::uuid id`)).rows[0].id;
  await asUser(db, ownerA, async () => {
    assert.equal((await db.query(`select * from public.calls where id='${id}'`)).rows.length, 1);
    assert.equal((await db.query(`select * from public.call_turns where call_id='${id}'`)).rows.length, 1);
    await assert.rejects(db.query(browser), /permission denied|row-level security/i);
    await assert.rejects(db.exec(`update public.calls set usage='{}' where id='${id}'`), /permission denied/i);
  });
  await asUser(db, ownerB, async () => {
    assert.equal((await db.query(`select * from public.calls where id='${id}'`)).rows.length, 0);
    assert.equal((await db.query(`select * from public.call_turns where call_id='${id}'`)).rows.length, 0);
  });
  console.log('Browser migration: constraints, phone compatibility, grants and tenant isolation passed');
} finally {
  await db.close();
}
