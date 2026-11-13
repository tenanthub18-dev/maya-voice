import {createServerClient} from '@supabase/ssr';
import {cookies} from 'next/headers';

export async function createAuthenticatedSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required in live mode');
  if (!publishableKey) throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required in live mode');
  const store = await cookies();
  // https://supabase.com/docs/guides/auth/server-side/creating-a-client
  return createServerClient(url, publishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll(values) {
        for (const {name, value, options} of values) store.set(name, value, options);
      },
    },
  });
}
