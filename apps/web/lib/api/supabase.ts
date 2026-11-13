import 'server-only';

import {createClient} from '@supabase/supabase-js';

import {SupabaseApiRepository, type SupabaseLike} from './repository';
import type {ApiRepository} from './repository';
import {mockApiRepository} from './mock-repository';
import {
  InMemoryFixedWindowRateLimiter,
  type PersistentRateLimiter,
  SupabaseFixedWindowRateLimiter,
} from './rate-limit';

function required(name: 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createApiRepository(env: Readonly<Record<string, string | undefined>> = process.env): ApiRepository {
  if ((env.DATA_SOURCE ?? 'mock') === 'mock') return mockApiRepository;
  // Secret service-role keys are server-only and bypass RLS.
  // https://supabase.com/docs/guides/api/api-keys
  const client = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
  });
  return new SupabaseApiRepository(client as unknown as SupabaseLike);
}

const mockRateLimitStore = new Map();

export function createPersistentRateLimiter(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PersistentRateLimiter {
  if ((env.DATA_SOURCE ?? 'mock') === 'mock') {
    return new InMemoryFixedWindowRateLimiter({store: mockRateLimitStore});
  }
  const client = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
  });
  return new SupabaseFixedWindowRateLimiter(client as unknown as ConstructorParameters<typeof SupabaseFixedWindowRateLimiter>[0]);
}
