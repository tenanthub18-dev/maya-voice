import {readFile} from 'node:fs/promises';
import {afterEach, describe, expect, it} from 'vitest';
import type {PGlite} from '@electric-sql/pglite';

import {createDatabase} from './database';

const migration = await readFile(new URL('../../../../supabase/migrations/20261112120100_exclude_browser_admin_usage.sql', import.meta.url), 'utf8');
let db: PGlite;
afterEach(async () => db?.close());

describe('browser admin usage migration with a non-superuser migrator', () => {
  it.each([false, true])('restores existing SET membership and CREATE privileges (%s)', async (preexisting) => {
    db = await createDatabase();
    await db.exec(`
      create role usage_migrator nologin inherit nosuperuser;
      grant usage,create on schema public to usage_migrator with grant option;
      grant admin_audit_executor to usage_migrator with admin true, inherit false, set ${preexisting};
      ${preexisting ? 'grant create on schema public to admin_audit_executor;' : ''}
      set role admin_audit_executor;
      grant execute on function public.list_admin_restaurant_usage() to public,anon,service_role;
      reset role;
      set session authorization usage_migrator;
    `);
    expect((await db.query<{rolsuper: boolean}>(`select rolsuper from pg_roles where rolname=current_user`)).rows[0]?.rolsuper).toBe(false);
    await db.exec(migration);
    expect((await db.query<{current_user: string}>('select current_user')).rows[0]?.current_user).toBe('usage_migrator');
    const privileges = (await db.query(`
      select pg_get_userbyid(proowner) owner,prosecdef,proconfig,
        has_function_privilege('anon',oid,'execute') anon,
        has_function_privilege('service_role',oid,'execute') service,
        has_function_privilege('authenticated',oid,'execute') authenticated,
        exists(select 1 from aclexplode(proacl) where grantee=0 and privilege_type='EXECUTE') public_execute,
        has_schema_privilege('admin_audit_executor','public','create') schema_create,
        pg_has_role(current_user,'admin_audit_executor','SET') can_set_owner
      from pg_proc where oid='public.list_admin_restaurant_usage()'::regprocedure
    `)).rows[0];
    expect(privileges).toEqual({owner: 'admin_audit_executor', prosecdef: true,
      proconfig: ['search_path=""'], anon: false, service: false, authenticated: true,
      public_execute: false, schema_create: preexisting, can_set_owner: preexisting});
    expect((await db.query(`
      select admin_option,inherit_option,set_option from pg_auth_members
      where roleid='admin_audit_executor'::regrole and member='usage_migrator'::regrole
    `)).rows).toEqual([{admin_option: true, inherit_option: false, set_option: preexisting}]);
    await db.exec('reset session authorization');
    expect((await db.query<{definition: string}>(`select pg_get_functiondef('public.list_admin_restaurant_usage()'::regprocedure) definition`)).rows[0]?.definition).toContain("call.source <> 'browser'");
  });
});
