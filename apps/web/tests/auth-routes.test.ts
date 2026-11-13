import {NextRequest} from 'next/server';
import {describe, expect, it, vi} from 'vitest';

import {getRouteAccessDecision} from '@/lib/auth/routes';

const exchangeCodeForSession = vi.fn();
const signOut = vi.fn();

vi.mock('@/lib/auth/server', () => ({
  createServerAuthProvider: async () => ({exchangeCodeForSession, signOut}),
}));

import {GET as authCallback} from '@/app/auth/callback/route';
import {POST as signOutRoute} from '@/app/auth/signout/route';

describe('protected route redirects', () => {
  it.each(['/home', '/calls', '/calls/call-1', '/agent', '/settings'])
    ('redirects signed-out access to %s with a safe returnTo', (pathname) => {
      expect(getRouteAccessDecision({pathname, search: '?tab=one', user: null}))
        .toEqual({kind: 'redirect', location: `/login?returnTo=${encodeURIComponent(`${pathname}?tab=one`)}`});
    });

  it.each(['/', '/login', '/signup', '/auth/callback', '/invite/accept'])
    ('allows the public route %s while signed out', (pathname) => {
      expect(getRouteAccessDecision({pathname, search: '', user: null})).toEqual({kind: 'allow'});
    });

  it('lets Telnyx SMS callbacks reach their own signature verification without a browser session', () => {
    expect(getRouteAccessDecision({pathname: '/api/webhooks/telnyx-sms', search: '', user: null}))
      .toEqual({kind: 'allow'});
    expect(getRouteAccessDecision({pathname: '/api/webhooks/telnyx-sms/other', search: '', user: null}).kind)
      .toBe('redirect');
  });

  it('exposes only the exact demo entry, code-protected session route and audio worklet', () => {
    for (const pathname of ['/demo', '/api/demo/session', '/audio/pcm-capture.js']) {
      expect(getRouteAccessDecision({pathname, search: '', user: null})).toEqual({kind: 'allow'});
    }
    expect(getRouteAccessDecision({pathname: '/api/demo/admin', search: '', user: null}).kind).toBe('redirect');
  });

  it.each(['owner', 'staff'] as const)('keeps %s users out of /admin without revealing it', (role) => {
    expect(getRouteAccessDecision({
      pathname: '/admin',
      search: '',
      user: {id: `${role}-1`, email: `${role}@example.com`, role, organizationId: 'org-1'},
    })).toEqual({kind: 'not-found'});
  });

  it('allows only platform admins into /admin', () => {
    expect(getRouteAccessDecision({
      pathname: '/admin',
      search: '',
      user: {id: 'admin-1', email: 'admin@example.com', role: 'platform-admin', organizationId: null},
    })).toEqual({kind: 'allow'});
  });
});

describe('auth callback', () => {
  it('handles missing codes and safe or hostile post-auth redirects', async () => {
    const missing = await authCallback(new NextRequest('https://app.example.com/auth/callback'));
    expect(missing.headers.get('location')).toBe('https://app.example.com/login?error=missing_code');

    exchangeCodeForSession.mockResolvedValueOnce({user: null});
    const safe = await authCallback(new NextRequest('https://app.example.com/auth/callback?code=ok&next=%2Fcalls%3Ftab%3Done'));
    expect(safe.headers.get('location')).toBe('https://app.example.com/calls?tab=one');

    exchangeCodeForSession.mockResolvedValueOnce({user: null});
    const hostile = await authCallback(new NextRequest('https://app.example.com/auth/callback?code=ok&next=%2F%2Fevil.example'));
    expect(hostile.headers.get('location')).toBe('https://app.example.com/home');
  });

  it('redirects failed code exchanges to a friendly login error', async () => {
    exchangeCodeForSession.mockRejectedValueOnce(new Error('expired code'));

    const response = await authCallback(new NextRequest('http://local/auth/callback?code=expired'));

    expect(response.headers.get('location')).toBe('http://local/login?error=callback_failed');
  });
});

describe('logout', () => {
  it('invalidates the local session and redirects only for the app origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
    signOut.mockResolvedValueOnce(undefined);
    const response = await signOutRoute(new NextRequest('https://app.example.com/auth/signout', {
      method: 'POST', headers: {origin: 'https://app.example.com'},
    }));
    expect(response.status).toBe(303);
    expect(signOut).toHaveBeenCalledOnce();

    signOut.mockClear();
    const rejected = await signOutRoute(new NextRequest('https://app.example.com/auth/signout', {
      method: 'POST', headers: {origin: 'https://attacker.example'},
    }));
    expect(rejected.status).toBe(403);
    expect(signOut).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('does not expose provider errors when logout invalidation fails', async () => {
    signOut.mockRejectedValueOnce(new Error('provider internals'));
    const response = await signOutRoute(new NextRequest('http://local/auth/signout', {method: 'POST'}));
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: {code: 'INTERNAL_ERROR', message: 'An unexpected error occurred'},
    });
  });
});
