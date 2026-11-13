import 'server-only';
import {createClient} from '@supabase/supabase-js';

// Secret keys bypass RLS and must remain in server-only route handlers.
// https://supabase.com/docs/guides/api/api-keys
export function createServiceSupabaseClient() {
  if (typeof window !== 'undefined') throw new Error('The Supabase service client is server-only');
  return createClient(required('SUPABASE_URL'), required('SUPABASE_SECRET_KEY'), {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false}
  });
}

function required(name: 'SUPABASE_URL' | 'SUPABASE_SECRET_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
