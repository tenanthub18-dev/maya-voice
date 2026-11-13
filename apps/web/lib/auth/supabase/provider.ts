import {createServerClient} from '@supabase/ssr';
import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';

import type {AuthCookieStore} from '../provider';
import type {AppRole} from '../permissions';
import type {AuthProvider, AuthResult, AuthUser} from '../types';

const membershipSchema = z.object({
  organization_id: z.string().uuid(),
  role: z.enum(['owner', 'staff']),
}).passthrough();

function textClaim(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function resolveUser(client: SupabaseClient): Promise<AuthUser | null> {
  // Server authorization must validate the JWT through getClaims, not trust getSession.
  // https://supabase.com/docs/guides/auth/server-side/nextjs
  const {data, error} = await client.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = data.claims as Record<string, unknown>;
  const id = textClaim(claims, 'sub');
  const email = textClaim(claims, 'email');
  if (!id || !email) return null;
  const appMetadata = typeof claims.app_metadata === 'object' && claims.app_metadata !== null
    ? claims.app_metadata as Record<string, unknown>
    : {};
  if (appMetadata.platform_admin === true) {
    return {id, email, role: 'platform-admin', organizationId: null};
  }
  const {data: membership, error: membershipError} = await client
    .from('memberships')
    .select('organization_id,role')
    .eq('user_id', id)
    .limit(1)
    .maybeSingle();
  if (membershipError) throw membershipError;
  // A newly verified owner has no organization until onboarding captures the restaurant identity.
  if (!membership) return {id, email, role: 'owner', organizationId: null};
  const parsedMembership = membershipSchema.parse(membership);
  const role: AppRole = parsedMembership.role;
  return {id, email, role, organizationId: parsedMembership.organization_id};
}

function result(user: AuthUser | null, redirectTo?: string): AuthResult {
  return redirectTo ? {user, redirectTo} : {user};
}

export function createSupabaseAuthProvider(input: {
  url: string;
  publishableKey: string;
  cookies: AuthCookieStore;
  client?: SupabaseClient;
}): AuthProvider {
  // Cookie adapter uses getAll/setAll as required by @supabase/ssr.
  // https://supabase.com/docs/guides/auth/server-side/creating-a-client
  const client = input.client ?? createServerClient(input.url, input.publishableKey, {cookies: input.cookies});
  return {
    getUser: () => resolveUser(client),
    async signUp({email, password, emailRedirectTo}) {
      // https://supabase.com/docs/reference/javascript/auth-signup
      const {error} = await client.auth.signUp({email, password, options: {emailRedirectTo}});
      if (error) throw error;
      return result(await resolveUser(client));
    },
    async signInWithPassword({email, password}) {
      // https://supabase.com/docs/reference/javascript/auth-signinwithpassword
      const {error} = await client.auth.signInWithPassword({email, password});
      if (error) throw error;
      return result(await resolveUser(client));
    },
    async signInWithGoogle({redirectTo}) {
      // https://supabase.com/docs/guides/auth/social-login/auth-google
      const {data, error} = await client.auth.signInWithOAuth({provider: 'google', options: {redirectTo}});
      if (error) throw error;
      return result(null, data.url);
    },
    async sendMagicLink({email, emailRedirectTo}) {
      // https://supabase.com/docs/reference/javascript/auth-signinwithotp
      const {error} = await client.auth.signInWithOtp({email, options: {emailRedirectTo}});
      if (error) throw error;
    },
    async exchangeCodeForSession(code) {
      // https://supabase.com/docs/guides/auth/social-login/auth-google
      const {error} = await client.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return result(await resolveUser(client));
    },
    async signOut() {
      // https://supabase.com/docs/reference/javascript/auth-signout
      const {error} = await client.auth.signOut({scope: 'local'});
      if (error) throw error;
    },
    async signInAsDemo() {
      throw new Error('Demo login is available only in mock mode');
    },
  };
}
