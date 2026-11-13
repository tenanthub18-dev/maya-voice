import {describe, expect, it, vi} from 'vitest';

import {createAuthProvider, secureAuthCookieStore, type AuthCookieStore} from '@/lib/auth/provider';
import {createInvitationEmailSender} from '@/lib/auth/invitation-server';

class MemoryCookies implements AuthCookieStore {
  readonly values = new Map<string, string>();

  getAll() {
    return [...this.values].map(([name, value]) => ({name, value}));
  }

  setAll(cookies: ReadonlyArray<{name: string; value: string}>) {
    for (const cookie of cookies) this.values.set(cookie.name, cookie.value);
  }
}

describe('auth provider selection', () => {
  it('enforces secure session cookie flags in production', () => {
    const setAll = vi.fn();
    const store = secureAuthCookieStore({getAll: () => [], setAll}, {NODE_ENV: 'production'});
    store.setAll([{name: 'sb-session', value: 'opaque', options: {sameSite: 'none', httpOnly: false}}]);
    expect(setAll).toHaveBeenCalledWith([{name: 'sb-session', value: 'opaque', options: expect.objectContaining({
      httpOnly: true, sameSite: 'lax', secure: true, path: '/',
    })}]);
  });
  it('does not read Supabase keys while constructing mock auth', async () => {
    const env = new Proxy({INTEGRATIONS_MODE: 'mock'}, {
      get(target, property: string) {
        if (property.includes('SUPABASE')) throw new Error('mock auth read a real provider key');
        return target[property as keyof typeof target];
      },
    });
    const provider = createAuthProvider({env, cookies: new MemoryCookies()});

    await expect(provider.getUser()).resolves.toBeNull();
  });

  it('does not read the Resend key while constructing the mock invitation sender', () => {
    const env = new Proxy({INTEGRATIONS_MODE: 'mock'}, {
      get(target, property: string) {
        if (property === 'RESEND_API_KEY') throw new Error('mock email read a real provider key');
        return target[property as keyof typeof target];
      },
    });
    expect(createInvitationEmailSender(env)).toBeDefined();
  });

  it('persists only fixed owner and staff demo identities in mock cookies', async () => {
    const cookies = new MemoryCookies();
    const provider = createAuthProvider({env: {INTEGRATIONS_MODE: 'mock'}, cookies});

    await provider.signInAsDemo('owner');
    await expect(provider.getUser()).resolves.toMatchObject({
      id: 'demo-owner',
      email: 'owner@demo.local',
      role: 'owner',
    });
    await provider.signInAsDemo('staff');
    await expect(provider.getUser()).resolves.toMatchObject({
      id: 'demo-staff',
      email: 'staff@demo.local',
      role: 'staff',
    });
  });

  it('removes the mock session on sign out', async () => {
    const cookies = new MemoryCookies();
    const provider = createAuthProvider({env: {INTEGRATIONS_MODE: 'mock'}, cookies});
    await provider.signInAsDemo('owner');
    await provider.signOut();
    await expect(provider.getUser()).resolves.toBeNull();
  });

  it('requires verified live Supabase public configuration', () => {
    expect(() => createAuthProvider({env: {INTEGRATIONS_MODE: 'live'}, cookies: new MemoryCookies()}))
      .toThrow(/NEXT_PUBLIC_SUPABASE_URL/u);
  });
});
