import type {CookieOptions} from '@supabase/ssr';

import {isMockAuth, type AuthEnvironment} from './mode';
import {createMockAuthProvider} from './mock';
import {createSupabaseAuthProvider} from './supabase/provider';
import type {AuthProvider} from './types';

export interface AuthCookieStore {
  getAll(): Array<{name: string; value: string}>;
  setAll(cookies: ReadonlyArray<{name: string; value: string; options?: CookieOptions}>): void;
}

export interface CreateAuthProviderOptions {
  env?: AuthEnvironment;
  cookies: AuthCookieStore;
}

export function secureAuthCookieStore(
  store: AuthCookieStore,
  env: AuthEnvironment = process.env,
): AuthCookieStore {
  return {
    getAll: () => store.getAll(),
    setAll(values) {
      store.setAll(values.map(({name, value, options}) => ({
        name,
        value,
        options: {
          ...options,
          httpOnly: true,
          sameSite: 'lax',
          secure: env.NODE_ENV === 'production',
          path: '/',
        },
      })));
    },
  };
}

export function createAuthProvider(options: CreateAuthProviderOptions): AuthProvider {
  const env = options.env ?? process.env;
  const cookies = secureAuthCookieStore(options.cookies, env);
  if (isMockAuth(env)) return createMockAuthProvider(cookies);
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) throw new Error('NEXT_PUBLIC_SUPABASE_URL is required in live mode');
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!publishableKey) throw new Error('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required in live mode');
  return createSupabaseAuthProvider({url, publishableKey, cookies});
}

export type {AuthProvider, AuthResult, AuthUser} from './types';
