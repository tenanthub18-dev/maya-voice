import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';

import {asUser, createDatabase} from './database';

const ADMIN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OWNER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const STAFF_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ORGANIZATION_ID = '10000000-0000-4000-8000-000000000001';
const RESTAURANT_ID = '30000000-0000-4000-8000-000000000003';
const PHONE_ID = '50000000-0000-4000-8000-000000000005';
const CALL_ID = '60000000-0000-4000-8000-000000000006';

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    insert into auth.users(id) values ('${ADMIN_ID}'), ('${OWNER_ID}'), ('${STAFF_ID}');
    insert into public.organizations(id,name,plan,spend_cap_cents)
      values ('${ORGANIZATION_ID}','Test Org','starter',10000);
    insert into public.memberships(user_id,organization_id,role) values
      ('${OWNER_ID}','${ORGANIZATION_ID}','owner'),
      ('${STAFF_ID}','${ORGANIZATION_ID}','staff');
    insert into public.restaurants(
      id,organization_id,name,address,province,timezone,primary_language,enabled_languages,status
    ) values (
      '${RESTAURANT_ID}','${ORGANIZATION_ID}','Test Restaurant','1 Main St','ON',
      'America/Toronto','en',array['en'],'live'
    );
    insert into public.agents(id,restaurant_id,persona_name,filler_level)
      values (md5('admin-agent')::uuid,'${RESTAURANT_ID}','Maya','natural');
    insert into public.agent_versions(id,agent_id,version_no,status)
      values (md5('admin-version')::uuid,md5('admin-agent')::uuid,1,'published');
    update public.agents set current_published_version_id=md5('admin-version')::uuid where id=md5('admin-agent')::uuid;
    insert into public.phone_numbers(id,restaurant_id,e164,telnyx_number_id,status)
      values ('${PHONE_ID}','${RESTAURANT_ID}','+14165550101','telnyx-number-1','active');
    insert into public.menu_items(restaurant_id,name,price_cents,category)
      values ('${RESTAURANT_ID}','Soup',900,'Lunch');
    insert into public.calls(
      id,restaurant_id,agent_version_id,telnyx_call_id,from_e164_hash,from_last4,started_at,outcome,recording_path
    ) values (
      '${CALL_ID}','${RESTAURANT_ID}',md5('admin-version')::uuid,'admin-call','hash','0101',now(),'answered','${RESTAURANT_ID}/call.wav'
    );
  `);
}

async function asAdmin<T>(db: PGlite, operation: () => Promise<T>, enabled = true): Promise<T> {
  return asUser(db, ADMIN_ID, operation, 'admin@example.com', {platform_admin: enabled});
}

async function startSession(db: PGlite, reason = 'Investigating a reported call issue'): Promise<string> {
  const result = await db.query<{id: string}>(
    'select (public.start_support_session($1,$2)).id',
    [RESTAURANT_ID, reason],
  );
  return result.rows[0]!.id;
}

describe('admin console database security', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await createDatabase();
    await seed(db);
  });

  afterEach(async () => db.close());

  it('keeps the audited executor non-login and grants only its required database capabilities', async () => {
    const role = (await db.query<{rolcanlogin: boolean; rolbypassrls: boolean}>(
      `select rolcanlogin,rolbypassrls from pg_roles where rolname='admin_audit_executor'`,
    )).rows[0];
    expect(role).toEqual({rolcanlogin: false, rolbypassrls: false});
    const privileges = (await db.query<{calls_select: boolean; phone_update: boolean; audit_insert: boolean; schema_create: boolean; authenticated_member: boolean; service_member: boolean}>(`
      select has_table_privilege('admin_audit_executor','public.calls','select') calls_select,
        has_column_privilege('admin_audit_executor','public.phone_numbers','kill_switch','update') phone_update,
        has_table_privilege('admin_audit_executor','public.audit_log','insert') audit_insert,
        has_schema_privilege('admin_audit_executor','public','create') schema_create,
        pg_has_role('authenticated','admin_audit_executor','member') authenticated_member,
        pg_has_role('service_role','admin_audit_executor','member') service_member
    `)).rows[0];
    expect(privileges).toEqual({calls_select: true, phone_update: true, audit_insert: true, schema_create: false, authenticated_member: false, service_member: false});
  });

  it('excludes browser calls and USD estimates from business usage without changing RPC privileges', async () => {
    await db.exec(`
      update public.calls set billable_seconds=60,cost_micros='{"llm":100,"tts":50}' where id='${CALL_ID}';
      insert into public.calls(id,restaurant_id,agent_version_id,source,started_at,billable_seconds,cost_micros)
        values (md5('browser-usage')::uuid,'${RESTAURANT_ID}',md5('admin-version')::uuid,
          'browser',now(),0,'{"llm":999999}');
    `);
    await asAdmin(db, async () => {
      const query = () => db.query<{calls: number; minutes: string; cost_micros: number}>(
        'select calls,minutes,cost_micros from public.list_admin_restaurant_usage()');
      expect((await query()).rows).toEqual([{calls: 1, minutes: '1.00000000000000000000', cost_micros: 150}]);
      expect((await query()).rows).toEqual((await query()).rows);
    });
    await asUser(db, OWNER_ID, async () => {
      expect((await db.query('select * from public.list_admin_restaurant_usage()')).rows).toEqual([]);
    });
    const definition = (await db.query<{owner: string; prosecdef: boolean; proconfig: string[]; anon: boolean; service: boolean}>(`
      select pg_get_userbyid(proowner) owner,prosecdef,proconfig,
        has_function_privilege('anon',oid,'execute') anon,
        has_function_privilege('service_role',oid,'execute') service
      from pg_proc where oid='public.list_admin_restaurant_usage()'::regprocedure
    `)).rows[0];
    expect(definition).toEqual({owner: 'admin_audit_executor', prosecdef: true,
      proconfig: ['search_path=""'], anon: false, service: false});
    expect((await db.query<{cost_micros: object}>(
      "select cost_micros from public.calls where source='browser'")).rows[0]?.cost_micros).toEqual({llm: 999999});
  });

  it('lets only a true platform-admin claim read admin tables', async () => {
    await asAdmin(db, async () => {
      expect((await db.query('select * from public.feature_flags')).rows).toEqual([]);
      expect((await db.query('select * from public.support_sessions')).rows).toEqual([]);
    });

    for (const [userId, metadata] of [[OWNER_ID, {}], [STAFF_ID, {}], [ADMIN_ID, {platform_admin: false}]] as const) {
      await asUser(db, userId, async () => {
        expect((await db.query('select * from public.feature_flags')).rows).toEqual([]);
        expect((await db.query('select * from public.support_sessions')).rows).toEqual([]);
        await expect(db.query('select * from public.audit_log')).rejects.toThrow(/permission denied/i);
        await expect(db.query('select * from public.list_admin_audit_logs()')).rejects.toThrow(/PLATFORM_ADMIN_REQUIRED/i);
      }, `${userId}@example.com`, metadata);
    }

    await db.exec('set role anon');
    try {
      await expect(db.query('select * from public.feature_flags')).rejects.toThrow(/permission denied/i);
      await expect(db.query('select * from public.support_sessions')).rejects.toThrow(/permission denied/i);
      await expect(db.query('update public.phone_numbers set kill_switch=true')).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec('reset role');
    }
  });

  it('starts one 30-minute session with a trimmed reason and an atomic audit row', async () => {
    await asAdmin(db, async () => {
      await expect(startSession(db, 'too short')).rejects.toThrow(/SUPPORT_REASON_REQUIRED/);
      const firstId = await startSession(db, '  Investigating a reported call issue  ');
      const first = (await db.query<{reason: string; duration_seconds: number; ended_at: string | null}>(`
        select reason,extract(epoch from (expires_at-started_at))::int duration_seconds,ended_at
        from public.support_sessions where id=$1
      `, [firstId])).rows[0]!;
      expect(first).toEqual({reason: 'Investigating a reported call issue', duration_seconds: 1800, ended_at: null});
      expect((await db.query(`select * from public.list_admin_audit_logs() where action='support_session.started' and target like $1`, [`%${firstId}%`])).rows).toHaveLength(1);

      await expect(startSession(db, 'Following up on the same restaurant issue')).rejects.toThrow(/SUPPORT_SESSION_ACTIVE/);

      await expect(db.query(`
        insert into public.support_sessions(admin_user_id,restaurant_id,reason,expires_at)
        values ($1,$2,'Attempting an invalid extended session',now()+interval '31 minutes')
      `, [ADMIN_ID, RESTAURANT_ID])).rejects.toThrow(/permission denied/i);
    });
  });

  it('ends a session irreversibly and audits the transition', async () => {
    await asAdmin(db, async () => {
      const sessionId = await startSession(db);
      await db.query('select public.end_support_session($1)', [sessionId]);
      expect((await db.query<{ended_at: string | null}>('select ended_at from public.support_sessions where id=$1', [sessionId])).rows[0]?.ended_at).not.toBeNull();
      expect((await db.query(`select * from public.list_admin_audit_logs() where action='support_session.ended' and target like $1`, [`%${sessionId}%`])).rows).toHaveLength(1);
      await expect(db.query('update public.support_sessions set ended_at=null where id=$1', [sessionId])).rejects.toThrow(/permission denied/i);
      await expect(db.query('select public.end_support_session($1)', [sessionId])).rejects.toThrow(/SUPPORT_SESSION_INACTIVE/);
    });
  });

  it('grants cross-tenant reads only during an active support session and never grants writes', async () => {
    await asAdmin(db, async () => {
      expect((await db.query('select name from public.menu_items')).rows).toEqual([]);
      const sessionId = await startSession(db, 'Reviewing restaurant configuration safely');
      expect((await db.query<{name: string}>('select name from public.menu_items')).rows).toEqual([{name: 'Soup'}]);
      await db.query(`update public.menu_items set price_cents=1 where restaurant_id=$1`, [RESTAURANT_ID]);
      expect((await db.query<{price_cents: number}>('select price_cents from public.menu_items')).rows[0]?.price_cents).toBe(900);
      await db.query('select public.end_support_session($1)', [sessionId]);
      expect((await db.query('select name from public.menu_items')).rows).toEqual([]);
    });
  });

  it('keeps support view read-only even when the platform admin also has an owner membership', async () => {
    await db.query(`insert into public.memberships(user_id,organization_id,role) values ($1,$2,'owner')`, [ADMIN_ID, ORGANIZATION_ID]);
    await asAdmin(db, async () => {
      await startSession(db);
      await db.query(`select set_config('app.admin_audited_write','on',false)`);
      await expect(db.query(`update public.menu_items set price_cents=1 where restaurant_id=$1`, [RESTAURANT_ID])).rejects.toThrow(/SUPPORT_VIEW_READ_ONLY/);
      await expect(db.query(`select public.save_agent_draft((select id from public.agents limit 1),'{}'::jsonb,'{}'::jsonb,'{}'::jsonb)`)).rejects.toThrow(/SUPPORT_VIEW_READ_ONLY/);
      await expect(db.query(`
        insert into public.organization_invitations(organization_id,inviter_user_id,email,role,token_hash,expires_at)
        values ($1,$2,'invitee@example.com','staff',$3,now()+interval '1 day')
      `, [ORGANIZATION_ID, ADMIN_ID, 'a'.repeat(64)])).rejects.toThrow(/SUPPORT_VIEW_READ_ONLY/);
      await expect(db.query(`update public.phone_numbers set kill_switch=true where id=$1`, [PHONE_ID])).rejects.toThrow(/permission denied|ADMIN_AUDIT_REQUIRED/);
    });
  });

  it('denies expired support sessions for tenant reads and recording access', async () => {
    await db.exec(`
      insert into public.support_sessions(admin_user_id,restaurant_id,reason,started_at,expires_at)
      values ('${ADMIN_ID}','${RESTAURANT_ID}','Expired investigation session',now()-interval '31 minutes',now()-interval '1 minute');
    `);
    await asAdmin(db, async () => {
      expect((await db.query('select name from public.menu_items')).rows).toEqual([]);
      await expect(db.query('select public.get_admin_recording_path($1)', [CALL_ID])).rejects.toThrow(/SUPPORT_SESSION_REQUIRED/);
    });
  });

  it('upserts global and restaurant flags through an audited RPC while preserving unique scopes', async () => {
    await asAdmin(db, async () => {
      await db.query(`select public.set_feature_flag('diner_payments',null,true)`);
      await db.query(`select public.set_feature_flag('diner_payments',$1,false)`, [RESTAURANT_ID]);
      await db.query(`select public.set_feature_flag('diner_payments',$1,true)`, [RESTAURANT_ID]);
      const flags = await db.query<{restaurant_id: string | null; enabled: boolean; updated_by: string}>(
        'select restaurant_id,enabled,updated_by from public.feature_flags order by restaurant_id nulls first',
      );
      expect(flags.rows).toEqual([
        {restaurant_id: null, enabled: true, updated_by: ADMIN_ID},
        {restaurant_id: RESTAURANT_ID, enabled: true, updated_by: ADMIN_ID},
      ]);
      expect((await db.query(`select * from public.list_admin_audit_logs() where action='feature_flag.toggled'`)).rows).toHaveLength(3);
      await expect(db.query(`insert into public.feature_flags(key,enabled,updated_by) values ('diner_payments',false,$1)`, [ADMIN_ID])).rejects.toThrow(/permission denied/i);
    });
  });

  it('toggles a number kill switch only through a reasoned audited RPC', async () => {
    await asAdmin(db, async () => {
      await expect(db.query('select public.set_phone_kill_switch($1,true,$2)', [PHONE_ID, 'too short'])).rejects.toThrow(/KILL_SWITCH_REASON_REQUIRED/);
      await db.query('select public.set_phone_kill_switch($1,true,$2)', [PHONE_ID, 'Suspected abusive traffic on this number']);
      expect((await db.query<{kill_switch: boolean}>('select kill_switch from public.phone_numbers where id=$1', [PHONE_ID])).rows[0]?.kill_switch).toBe(true);
      expect((await db.query<{reason: string}>(`select reason from public.list_admin_audit_logs() where action='phone_number.kill_switch.enabled'`)).rows).toEqual([{reason: 'Suspected abusive traffic on this number'}]);
      await expect(db.query('update public.phone_numbers set kill_switch=false where id=$1', [PHONE_ID])).rejects.toThrow(/permission denied/i);
    });

    for (const userId of [OWNER_ID, STAFF_ID]) {
      await asUser(db, userId, async () => {
        await expect(db.query('select public.set_phone_kill_switch($1,false,$2)', [PHONE_ID, 'Unauthorized change attempt'])).rejects.toThrow(/PLATFORM_ADMIN_REQUIRED/);
      });
    }
  });

  it('audits admin recording authorization before returning its private path', async () => {
    await asAdmin(db, async () => {
      await expect(db.query('select public.get_admin_recording_path($1)', [CALL_ID])).rejects.toThrow(/SUPPORT_SESSION_REQUIRED/);
      const sessionId = await startSession(db, 'Listening to investigate a reported transcript issue');
      const result = await db.query<{path: string}>('select public.get_admin_recording_path($1) path', [CALL_ID]);
      expect(result.rows[0]?.path).toBe(`${RESTAURANT_ID}/call.wav`);
      expect((await db.query<{target: string; reason: string}>(`select target,reason from public.list_admin_audit_logs() where action='recording.read'`)).rows).toEqual([{
        target: `call:${CALL_ID}:session:${sessionId}`,
        reason: 'Listening to investigate a reported transcript issue',
      }]);
    });
  });

  it('makes audit rows append-only even for service-role access', async () => {
    await asAdmin(db, async () => {
      await db.query(`select public.set_feature_flag('diner_payments',null,true)`);
      await expect(db.query(`update public.audit_log set reason='changed'`)).rejects.toThrow(/permission denied/i);
      await expect(db.query('delete from public.audit_log')).rejects.toThrow(/permission denied/i);
    });

    await db.exec('grant update on public.phone_numbers to service_role; set role service_role');
    try {
      await db.query(`insert into public.audit_log(actor_id,action,target,reason) values (null,'service.test','test','append works')`);
      await db.query(`select set_config('app.admin_audited_write','on',false)`);
      await expect(db.query(`insert into public.feature_flags(key,enabled) values ('service_bypass',true)`)).rejects.toThrow(/permission denied|ADMIN_AUDIT_REQUIRED/i);
      await expect(db.query(`update public.phone_numbers set kill_switch=true where id='${PHONE_ID}'`)).rejects.toThrow(/permission denied|ADMIN_AUDIT_REQUIRED/i);
      await expect(db.query(`truncate public.feature_flags,public.support_sessions`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`select public.set_feature_flag('diner_payments',null,true)`)).rejects.toThrow(/permission denied/i);
      await expect(db.query(`update public.audit_log set reason='changed'`)).rejects.toThrow(/permission denied/i);
      await expect(db.query('delete from public.audit_log')).rejects.toThrow(/permission denied/i);
    } finally {
      await db.exec('reset role');
    }
  });

  it('allows restaurant privacy deletion after support and feature records exist while retaining the audit trail', async () => {
    await asAdmin(db, async () => {
      await startSession(db, 'Investigating before an approved deletion');
      await db.query(`select public.set_feature_flag('diner_payments',$1,true)`, [RESTAURANT_ID]);
    });

    const result = await db.query<{value: {result: {restaurantDeleted: boolean}}}>(
      `select public.execute_restaurant_privacy_request($1,$2,$3,'delete',$4::text[]) value`,
      [OWNER_ID, ORGANIZATION_ID, RESTAURANT_ID, [`${RESTAURANT_ID}/call.wav`]],
    );
    expect(result.rows[0]?.value.result.restaurantDeleted).toBe(true);
    expect((await db.query('select * from public.restaurants where id=$1', [RESTAURANT_ID])).rows).toEqual([]);
    expect((await db.query('select * from public.feature_flags where restaurant_id=$1', [RESTAURANT_ID])).rows).toEqual([]);
    expect((await db.query('select * from public.support_sessions where restaurant_id=$1', [RESTAURANT_ID])).rows).toEqual([]);
    expect((await db.query(`select action from public.audit_log where target like $1 order by created_at`, [`%${RESTAURANT_ID}%`])).rows.length).toBeGreaterThanOrEqual(3);
  });
});
