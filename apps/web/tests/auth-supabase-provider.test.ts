import type {SupabaseClient} from '@supabase/supabase-js';
import {describe, expect, it, vi} from 'vitest';

import {createSupabaseAuthProvider} from '@/lib/auth/supabase/provider';

const cookies = {getAll: () => [], setAll: () => undefined};

function clientWith(input: {membership: unknown; authError?: Error}): SupabaseClient {
  const maybeSingle = vi.fn().mockResolvedValue({data: input.membership, error: null});
  const client = {
    auth: {
      getClaims: vi.fn().mockResolvedValue({
        data: {claims: {sub: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@example.com'}},
        error: null,
      }),
      signInWithPassword: vi.fn().mockResolvedValue({data: null, error: input.authError ?? null}),
      signUp: vi.fn(), signInWithOAuth: vi.fn(), signInWithOtp: vi.fn(),
      exchangeCodeForSession: vi.fn(), signOut: vi.fn(),
    },
    from: vi.fn(() => ({
      select: () => ({eq: () => ({limit: () => ({maybeSingle})})}),
    })),
  };
  return client as unknown as SupabaseClient;
}

describe('Supabase auth provider boundary', () => {
  it('maps validated claims and membership to an application user', async () => {
    const provider = createSupabaseAuthProvider({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      cookies,
      client: clientWith({membership: {organization_id: '10000000-0000-4000-8000-000000000001', role: 'owner'}}),
    });
    await expect(provider.getUser()).resolves.toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      email: 'owner@example.com',
      organizationId: '10000000-0000-4000-8000-000000000001',
      role: 'owner',
    });
  });

  it('fails loudly when a successful membership response has the wrong schema', async () => {
    const provider = createSupabaseAuthProvider({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      cookies,
      client: clientWith({membership: {organization_id: 7, role: 'superuser'}}),
    });
    await expect(provider.getUser()).rejects.toThrow(/organization_id|role/u);
  });

  it('preserves Supabase authentication errors', async () => {
    const authError = new Error('Invalid login credentials');
    const provider = createSupabaseAuthProvider({
      url: 'https://project.supabase.co',
      publishableKey: 'sb_publishable_test',
      cookies,
      client: clientWith({membership: null, authError}),
    });
    await expect(provider.signInWithPassword({email: 'owner@example.com', password: 'wrong'})).rejects.toBe(authError);
  });
});
