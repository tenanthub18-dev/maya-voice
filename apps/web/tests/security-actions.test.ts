import {describe, expect, it} from 'vitest';

import {
  assertStrictActionObject,
  assertStrictFormData,
  validateActionOrigin,
} from '@/lib/security/actions';

describe('server action origin validation', () => {
  it('accepts the configured app origin and rejects missing or cross-site origins', () => {
    const env: NodeJS.ProcessEnv = {NODE_ENV: 'test', NEXT_PUBLIC_APP_URL: 'https://app.example.com'};
    expect(validateActionOrigin(new Headers({origin: 'https://app.example.com'}), env)).toBe(true);
    expect(validateActionOrigin(new Headers({origin: 'https://attacker.example'}), env)).toBe(false);
    expect(validateActionOrigin(new Headers(), env)).toBe(false);
  });

  it('fails closed in production when the application origin is not configured', () => {
    expect(validateActionOrigin(new Headers({origin: 'https://app.example.com'}), {
      NODE_ENV: 'production',
    })).toBe(false);
  });
});

describe('server action input validation', () => {
  it('accepts React Server Action metadata while still validating application fields', () => {
    const form = new FormData();
    form.set('$ACTION_ID_40b389c4a165c0137f0643f8a30a4628136f764e55', '');
    form.set('intent', 'demo');
    expect(() => assertStrictFormData(form, ['intent'])).not.toThrow();
  });

  it('rejects unknown FormData fields', () => {
    const form = new FormData();
    form.set('name', 'Restaurant');
    form.set('isAdmin', 'true');
    expect(() => assertStrictFormData(form, ['name'])).toThrow();
  });

  it('rejects unknown object fields', () => {
    expect(() => assertStrictActionObject({name: 'Restaurant', isAdmin: true}, ['name'])).toThrow();
  });

  it('rejects action bodies larger than 64 KiB', () => {
    const form = new FormData();
    form.set('name', 'x'.repeat(65 * 1_024));
    expect(() => assertStrictFormData(form, ['name'])).toThrow('Request body is too large');
    expect(() => assertStrictActionObject({name: 'x'.repeat(65 * 1_024)}, ['name']))
      .toThrow('Request body is too large');
  });
});
