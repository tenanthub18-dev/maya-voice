'use server';

import {createAuthenticatedSupabaseClient} from '@/lib/auth/supabase/server-client';

export async function getRealtimeAccessToken(): Promise<string | null> {
  const client = await createAuthenticatedSupabaseClient();
  // This reads the current session only to authenticate the Realtime socket; all
  // authorization remains enforced by Postgres RLS.
  // https://supabase.com/docs/guides/realtime/postgres-changes#custom-tokens
  const {data, error} = await client.auth.getSession();
  if (error) throw error;
  return data.session?.access_token ?? null;
}
