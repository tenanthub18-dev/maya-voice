'use client';

import {RealtimeClient} from '@supabase/supabase-js';
import {getRealtimeAccessToken} from '@/lib/live/realtime-token';

export function createBrowserRealtimeClient() {
  const url = required(process.env.NEXT_PUBLIC_SUPABASE_URL, 'NEXT_PUBLIC_SUPABASE_URL').replace(/\/+$/u, '');
  const publishableKey = required(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  // Standalone Realtime client for bundle-sensitive environments:
  // https://supabase.com/docs/reference/javascript/subscribe
  return new RealtimeClient(`${url}/realtime/v1`, {
    accessToken: getRealtimeAccessToken,
    params: {apikey: publishableKey},
  });
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
