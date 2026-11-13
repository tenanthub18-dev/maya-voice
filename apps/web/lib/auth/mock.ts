import type {AuthCookieStore} from './provider';
import type {AuthProvider, AuthResult, AuthUser} from './types';

const MOCK_SESSION_COOKIE = 'voice-receptionist-demo-session';
const DEMO_USERS = {
  owner: {id: 'demo-owner', email: 'owner@demo.local', role: 'owner', organizationId: '22222222-2222-4222-8222-222222222222'},
  staff: {id: 'demo-staff', email: 'staff@demo.local', role: 'staff', organizationId: '22222222-2222-4222-8222-222222222222'},
} as const satisfies Record<'owner' | 'staff', AuthUser>;

function unsupported(): never {
  throw new Error('Credential authentication is available only in live mode');
}

export function createMockAuthProvider(cookies: AuthCookieStore): AuthProvider {
  return {
    async getUser() {
      const value = cookies.getAll().find((cookie) => cookie.name === MOCK_SESSION_COOKIE)?.value;
      return value === 'owner' || value === 'staff' ? DEMO_USERS[value] : null;
    },
    async signInAsDemo(role): Promise<AuthResult> {
      cookies.setAll([{name: MOCK_SESSION_COOKIE, value: role, options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 12,
      }}]);
      return {user: DEMO_USERS[role]};
    },
    async signOut() {
      cookies.setAll([{name: MOCK_SESSION_COOKIE, value: '', options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 0,
      }}]);
    },
    async signUp() { return unsupported(); },
    async signInWithPassword() { return unsupported(); },
    async signInWithGoogle() { return unsupported(); },
    async sendMagicLink() { return unsupported(); },
    async exchangeCodeForSession() { return unsupported(); },
  };
}
