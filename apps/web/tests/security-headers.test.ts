import {NextRequest} from 'next/server';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const authMock = vi.hoisted(() => ({
  user: {id: 'user-1', email: 'owner@example.com', role: 'owner'} as Record<string, unknown> | null,
  setCookie: false,
}));

vi.mock('@/lib/auth/provider', () => ({
  createAuthProvider: (options: {cookies: {setAll(values: unknown[]): void}}) => ({getUser: async () => {
    if (authMock.setCookie) options.cookies.setAll([{
      name: 'sb-session', value: 'rotated',
      options: {httpOnly: true, secure: true, sameSite: 'lax', path: '/'},
    }]);
    return authMock.user;
  }}),
}));

import {proxy} from '@/proxy';
import {contentSecurityPolicy} from '@/lib/security/headers';

describe('web security headers', () => {
  it('allows React development debugging only in development, keeping production eval disabled', () => {
    expect(contentSecurityPolicy('test', {NODE_ENV: 'development'})).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy('test', {NODE_ENV: 'production'})).not.toContain("'unsafe-eval'");
  });
  beforeEach(() => {
    vi.stubEnv('INTEGRATIONS_MODE', 'mock');
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://tenant.supabase.co');
    vi.stubEnv('WORKER_BASE_URL', 'https://worker.example.com');
    authMock.user = {id: 'user-1', email: 'owner@example.com', role: 'owner'};
    authMock.setCookie = false;
  });

  it.each([
    ['dashboard', 'https://app.example.com/home'],
    ['agent editor', 'https://app.example.com/agent?tab=persona'],
    ['browser test call', 'https://app.example.com/agent?tab=testCall'],
  ])('protects the rendered %s page without weakening script execution', async (_name, url) => {
    const response = await proxy(new NextRequest(url));
    const csp = response.headers.get('content-security-policy') ?? '';
    const scriptDirective = csp.split(';').find((directive) => directive.trim().startsWith('script-src')) ?? '';

    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/u);
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('https://tenant.supabase.co');
    expect(csp).toContain('wss://tenant.supabase.co');
    expect(csp).not.toContain('https://worker.example.com');
    expect(csp).toMatch(/media-src [^;]*https:\/\/tenant\.supabase\.co/u);
    expect(response.headers.get('strict-transport-security')).toBe('max-age=63072000; includeSubDomains; preload');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-resource-policy')).toBe('same-origin');
  });

  it('allows microphone access only for the browser test-call document', async () => {
    const testCall = await proxy(new NextRequest('https://app.example.com/agent?tab=testCall'));
    const ordinaryPage = await proxy(new NextRequest('https://app.example.com/agent?tab=persona'));

    expect(testCall.headers.get('permissions-policy')).toContain('microphone=(self)');
    expect(ordinaryPage.headers.get('permissions-policy')).toContain('microphone=()');
  });

  it('permits the public demo microphone and only the configured secure audio origin', async () => {
    authMock.user = null;
    const demo = await proxy(new NextRequest('https://app.example.com/demo'));
    expect(demo.status).toBe(200);
    expect(demo.headers.get('permissions-policy')).toContain('microphone=(self)');
    expect(demo.headers.get('content-security-policy')).toContain('wss://worker.example.com');
    expect(demo.headers.get('content-security-policy')).not.toContain('wss://evil.example.com');
  });

  it('passes the CSP nonce to the Next.js request renderer', async () => {
    const response = await proxy(new NextRequest('https://app.example.com/home'));
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = csp.match(/'nonce-([^']+)'/u)?.[1];

    expect(nonce).toBeTruthy();
    expect(response.headers.get('x-nonce')).toBe(nonce);
  });

  it('preserves secure rotated session-cookie flags across auth redirects', async () => {
    authMock.user = null;
    authMock.setCookie = true;
    const response = await proxy(new NextRequest('https://app.example.com/home'));
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(response.status).toBe(307);
    expect(setCookie).toContain('sb-session=rotated');
    expect(setCookie).toMatch(/HttpOnly/iu);
    expect(setCookie).toMatch(/Secure/iu);
    expect(setCookie).toMatch(/SameSite=lax/iu);
    expect(setCookie).toMatch(/Path=\//iu);
  });
});
