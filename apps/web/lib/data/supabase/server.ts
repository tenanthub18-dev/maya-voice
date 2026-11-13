import {createServerClient} from '@supabase/ssr';
import {cookies} from 'next/headers';
import type {SupabaseClientLike, SupabaseResultLike, SupabaseTableLike} from './index';

// https://supabase.com/docs/guides/auth/server-side/nextjs
export async function createServerSupabaseClient(): Promise<SupabaseClientLike> {
  const cookieStore = await cookies();
  const client = createServerClient(required('NEXT_PUBLIC_SUPABASE_URL'), required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(values) {
        try {
          for (const {name, value, options} of values) cookieStore.set(name, value, options);
        } catch (error) {
          if (!isReadOnlyCookieStoreError(error)) throw error;
        }
      }
    }
  });

  return {
    from(table) {
      return client.from(table) as unknown as SupabaseTableLike;
    },
    rpc(functionName, args) {
      return client.rpc(functionName, args) as unknown as PromiseLike<SupabaseResultLike>;
    },
    auth: {
      getUser: () => client.auth.getUser()
    }
  };
}

function required(name: 'NEXT_PUBLIC_SUPABASE_URL' | 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function isReadOnlyCookieStoreError(error: unknown): boolean {
  return error instanceof Error && /cookies can only be modified|read-only/i.test(error.message);
}
