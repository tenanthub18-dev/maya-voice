import {beforeEach, describe, expect, it, vi} from 'vitest';

import {AuthorizationError} from '@/lib/auth/guards';

const runtime = vi.hoisted(() => ({role: 'owner' as 'owner' | 'staff' | 'platform-admin'}));
const source = vi.hoisted(() => ({
  startSupportSession: vi.fn(), endSupportSession: vi.fn(), setFeatureFlag: vi.fn(), setPhoneKillSwitch: vi.fn(),
}));

vi.mock('@/lib/auth/guards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/guards')>();
  return {...actual, requireActionCapability: vi.fn(async (capability: string) => {
    if (capability !== 'accessAdmin' || runtime.role !== 'platform-admin') throw new actual.AuthorizationError(403);
    return {id: 'admin', email: 'admin@example.com', role: 'platform-admin', organizationId: null};
  })};
});
vi.mock('@/lib/data', () => ({getDataSource: () => source}));
vi.mock('next/cache', () => ({revalidatePath: vi.fn()}));
vi.mock('next/navigation', () => ({redirect: vi.fn()}));
vi.mock('next/headers', () => ({headers: async () => new Headers()}));

import {endSupportSession, startSupportSession, toggleFeatureFlag, togglePhoneKillSwitch} from '@/app/admin/actions';

const requests = [
  () => startSupportSession(form({restaurantId: 'restaurant-1', reason: 'Investigating a reported call issue'})),
  () => endSupportSession(form({sessionId: 'session-1'})),
  () => toggleFeatureFlag(form({key: 'diner_payments', restaurantId: '', enabled: 'true'})),
  () => togglePhoneKillSwitch(form({phoneNumberId: 'phone-1', enabled: 'true', reason: 'Suspected abusive traffic'})),
];

describe('admin action authorization', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['owner', 'staff'] as const)('rejects every admin mutation for %s users with a typed authorization error', async (role) => {
    runtime.role = role;
    for (const request of requests) {
      await expect(request()).rejects.toEqual(expect.objectContaining<Partial<AuthorizationError>>({name: 'AuthorizationError', status: 403}));
    }
    expect(source.startSupportSession).not.toHaveBeenCalled();
    expect(source.endSupportSession).not.toHaveBeenCalled();
    expect(source.setFeatureFlag).not.toHaveBeenCalled();
    expect(source.setPhoneKillSwitch).not.toHaveBeenCalled();
  });
});

function form(values: Record<string, string>): FormData {
  const result = new FormData();
  for (const [key, value] of Object.entries(values)) result.set(key, value);
  return result;
}
