import {describe, expect, it} from 'vitest';

import {
  assertDemoLoginAllowed,
  getCapabilitiesForRole,
  hasCapability,
  sanitizeReturnTo,
} from '@/lib/auth';

describe('authorization role matrix', () => {
  const matrix = [
    {role: 'owner' as const, publishAgent: true, changeBilling: true, inviteMembers: true, accessAdmin: false},
    {role: 'staff' as const, publishAgent: false, changeBilling: false, inviteMembers: false, accessAdmin: false},
    {role: 'platform-admin' as const, publishAgent: false, changeBilling: false, inviteMembers: false, accessAdmin: true},
  ];

  it.each(matrix)('$role has only its allowed privileged capabilities', ({role, ...expected}) => {
    expect(getCapabilitiesForRole(role)).toMatchObject(expected);
  });

  it('denies every privileged owner action to staff', () => {
    expect(hasCapability('staff', 'publishAgent')).toBe(false);
    expect(hasCapability('staff', 'changeBilling')).toBe(false);
    expect(hasCapability('staff', 'inviteMembers')).toBe(false);
  });
});

describe('safe authentication redirects', () => {
  it.each([
    ['missing', undefined],
    ['absolute URL', 'https://evil.example/steal'],
    ['protocol-relative URL', '//evil.example/steal'],
    ['encoded protocol-relative URL', '/%2f%2fevil.example/steal'],
    ['backslash URL', '/\\evil.example/steal'],
    ['login loop', '/login?returnTo=/home'],
    ['signup loop', '/signup'],
    ['callback loop', '/auth/callback?code=x'],
    ['encoded backslash', '/%5cevil.example/steal'],
    ['encoded control character', '/calls%0d%0aLocation:https://evil.example'],
    ['Unicode division slash', '/∕∕evil.example/steal'],
  ])('falls back to /home for %s', (_label, value) => {
    expect(sanitizeReturnTo(value)).toBe('/home');
  });

  it('preserves a local path and query', () => {
    expect(sanitizeReturnTo('/calls/call-1?tab=transcript')).toBe('/calls/call-1?tab=transcript');
  });
});

describe('demo login mode boundary', () => {
  it('allows one-click login only in mock mode', () => {
    expect(() => assertDemoLoginAllowed({INTEGRATIONS_MODE: 'mock'})).not.toThrow();
    expect(() => assertDemoLoginAllowed({INTEGRATIONS_MODE: 'live'})).toThrow(/mock mode/i);
  });
});
