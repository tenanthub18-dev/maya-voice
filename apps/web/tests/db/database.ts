import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';

const root = path.resolve(import.meta.dirname, '../../../..');

export async function createDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object(
        'sub', nullif(current_setting('request.jwt.claim.sub', true), ''),
        'email', nullif(current_setting('request.jwt.claim.email', true), ''),
        'app_metadata', coalesce(
          nullif(current_setting('request.jwt.claim.app_metadata', true), '')::jsonb,
          '{}'::jsonb
        )
      )
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant execute on function auth.jwt() to authenticated;
    create schema storage;
    create table storage.buckets (id text primary key, name text not null unique, public boolean not null default false);
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null references storage.buckets(id), name text not null);
    alter table storage.objects enable row level security;
    create function storage.foldername(name text) returns text[] language sql immutable as $$
      select string_to_array(name, '/')
    $$;
    create publication supabase_realtime;
  `);

  const directory = path.join(root, 'supabase/migrations');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) await db.exec(await readFile(path.join(directory, file), 'utf8'));
  return db;
}

export async function asUser<T>(
  db: PGlite,
  userId: string,
  operation: () => Promise<T>,
  email = `${userId}@example.com`,
  appMetadata: Readonly<Record<string, unknown>> = {},
): Promise<T> {
  const metadata = JSON.stringify(appMetadata).replaceAll("'", "''");
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false); select set_config('request.jwt.claim.email', '${email.replaceAll("'", "''")}', false); select set_config('request.jwt.claim.app_metadata', '${metadata}', false);`);
  try {
    return await operation();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false); select set_config('request.jwt.claim.email', '', false); select set_config('request.jwt.claim.app_metadata', '', false);`);
  }
}
