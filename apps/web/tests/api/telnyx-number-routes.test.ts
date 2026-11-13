import {describe, expect, it, vi} from 'vitest';

import type {AuthUser} from '@/lib/auth/types';
import {
  createAssignNumberHandler,
  createBuyNumberHandler,
  createReleaseNumberHandler,
  createSearchNumbersHandler,
  createVerifyForwardingHandler,
  type NumberRoutesDependencies,
} from '@/app/api/telnyx/numbers/_lib';

const owner: AuthUser = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  role: 'owner',
  organizationId: '00000000-0000-4000-8000-000000000002',
};
const restaurantId = '00000000-0000-4000-8000-000000000003';
const phoneId = '00000000-0000-4000-8000-000000000004';

function request(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-forwarded-for': '203.0.113.4'},
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Partial<NumberRoutesDependencies> = {}) {
  const state = {
    saved: [] as Array<Record<string, unknown>>,
    updated: [] as Array<{id: string; value: Record<string, unknown>}>,
    audits: [] as Array<{actorId: string; action: string; target: string; reason: string}>,
    finalized: [] as Array<{phoneId: string; actorId: string; target: string; reason: string}>,
    searches: [] as unknown[],
    orders: [] as unknown[],
    releases: [] as string[],
    assignments: [] as Array<[string, string]>,
  };
  const deps: NumberRoutesDependencies = {
    authorize: async () => ({ok: true, user: owner}),
    consumeRateLimit: () => null,
    purchaseLimiter: {consume: async () => ({allowed: true, retryAfterSeconds: 0})},
    repository: {
      findRestaurantOrganizationId: async () => owner.organizationId,
      getPhoneNumber: async () => ({
        id: phoneId,
        restaurantId,
        e164: '+14165550123',
        telnyxNumberId: 'telnyx-number-1',
        status: 'active',
      }),
      savePhoneNumber: async (value) => {
        state.saved.push(value);
        return phoneId;
      },
      updatePhoneNumber: async (id, value) => { state.updated.push({id, value}); },
      finalizePhoneRelease: async (value) => { state.finalized.push(value); },
      writeAudit: async (value) => { state.audits.push(value); },
    },
    telnyx: {
      searchNumbers: async (input) => {
        state.searches.push(input);
        return {data: [{phone_number: '+14165550123'}]};
      },
      orderNumber: async (input) => {
        state.orders.push(input);
        return {data: {
          id: 'order-1', record_type: 'number_order', status: 'success',
          phone_numbers: [{id: 'telnyx-number-1', phone_number: '+14165550123', status: 'active'}],
        }};
      },
      releaseNumber: async (id) => {
        state.releases.push(id);
        return {data: {id, record_type: 'phone_number', phone_number: '+14165550123', status: 'deleted'}};
      },
      assignToTeXmlApp: async (id, appId) => {
        state.assignments.push([id, appId]);
        return {data: {id, record_type: 'phone_number', phone_number: '+14165550123', status: 'active'}};
      },
    },
    texmlAppId: 'texml-app-1',
    messagingProfileId: 'messaging-profile-1',
    ...overrides,
  };
  return {deps, state};
}

async function error(response: Response) {
  return response.json() as Promise<{error: {code: string; message: string}}>;
}

describe('Telnyx number routes', () => {
  it('searches Canadian numbers for an owned restaurant', async () => {
    const {deps, state} = dependencies();
    const response = await createSearchNumbersHandler(deps)(request('/api/telnyx/numbers/search', {
      restaurantId, areaCode: '416', limit: 3,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({data: [{phone_number: '+14165550123'}]});
    expect(state.searches).toEqual([{areaCode: '416', countryCode: 'CA', limit: 3}]);
  });

  it('rejects malformed requests before calling Telnyx', async () => {
    const {deps, state} = dependencies();
    const response = await createSearchNumbersHandler(deps)(request('/api/telnyx/numbers/search', {
      restaurantId, areaCode: '41',
    }));
    expect(response.status).toBe(400);
    expect(await error(response)).toEqual({error: {code: 'INVALID_REQUEST', message: 'Request body is invalid'}});
    expect(state.searches).toEqual([]);
  });

  it('distinguishes signed-out, staff, and cross-organization requests', async () => {
    const signedOut = dependencies({authorize: async () => ({
      ok: false,
      response: Response.json({error: {code: 'UNAUTHORIZED', message: 'Authentication required'}}, {status: 401}),
    })});
    expect((await createSearchNumbersHandler(signedOut.deps)(request('/api/telnyx/numbers/search', {
      restaurantId, areaCode: '416',
    }))).status).toBe(401);

    const staff = dependencies({authorize: async () => ({
      ok: false,
      response: Response.json({error: {code: 'FORBIDDEN', message: 'Insufficient permissions'}}, {status: 403}),
    })});
    expect((await createSearchNumbersHandler(staff.deps)(request('/api/telnyx/numbers/search', {
      restaurantId, areaCode: '416',
    }))).status).toBe(403);

    const crossOrg = dependencies({repository: {
      ...dependencies().deps.repository,
      findRestaurantOrganizationId: async () => '00000000-0000-4000-8000-000000000099',
    }});
    const response = await createSearchNumbersHandler(crossOrg.deps)(request('/api/telnyx/numbers/search', {
      restaurantId, areaCode: '416',
    }));
    expect(response.status).toBe(403);
    expect((await error(response)).error.code).toBe('FORBIDDEN');
  });

  it('enforces the shared per-IP and per-user rate limit', async () => {
    const {deps} = dependencies({consumeRateLimit: () =>
      Response.json({error: {code: 'RATE_LIMITED', message: 'Too many requests'}}, {status: 429})});
    const response = await createSearchNumbersHandler(deps)(request('/api/telnyx/numbers/search', {
      restaurantId, areaCode: '416',
    }));
    expect(response.status).toBe(429);
  });

  it('buys, persists, and audits a number only after provider success', async () => {
    const {deps, state} = dependencies();
    const response = await createBuyNumberHandler(deps)(request('/api/telnyx/numbers/buy', {
      restaurantId, phoneNumber: '+14165550123',
    }));
    expect(response.status).toBe(201);
    expect(await response.clone().json()).toMatchObject({phoneNumberId: phoneId});
    expect(state.saved).toEqual([{
      restaurant_id: restaurantId,
      e164: '+14165550123',
      telnyx_number_id: 'telnyx-number-1',
      status: 'active',
    }]);
    expect(state.orders).toEqual([{
      phoneNumber: '+14165550123', customerReference: restaurantId,
      messagingProfileId: 'messaging-profile-1',
    }]);
    expect(state.audits).toEqual([{
      actorId: owner.id,
      action: 'phone_number.buy',
      target: 'telnyx-number-1',
      reason: 'Telnyx number purchase',
    }]);
  });

  it('enforces five number purchases per day per organization', async () => {
    const consume = vi.fn(async () => ({allowed: false, retryAfterSeconds: 3_600}));
    const {deps, state} = dependencies({purchaseLimiter: {consume}});

    const response = await createBuyNumberHandler(deps)(request('/api/telnyx/numbers/buy', {
      restaurantId, phoneNumber: '+14165550123',
    }));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3600');
    expect(consume).toHaveBeenCalledWith({
      scope: 'number-purchase', key: owner.organizationId, limit: 5, windowSeconds: 86_400,
    });
    expect(state.orders).toEqual([]);
  });

  it('releases an owned number, marks it released, and records the reason', async () => {
    const {deps, state} = dependencies();
    const response = await createReleaseNumberHandler(deps)(request('/api/telnyx/numbers/release', {
      phoneNumberId: phoneId, reason: 'Restaurant closed',
    }));
    expect(response.status).toBe(200);
    expect(state.releases).toEqual(['telnyx-number-1']);
    expect(state.updated).toEqual([{id: phoneId, value: {status: 'releasing'}}]);
    expect(state.finalized).toEqual([{
      phoneId, actorId: owner.id, target: 'telnyx-number-1', reason: 'Restaurant closed',
    }]);
  });

  it('acknowledges an already released number without deleting it again', async () => {
    const base = dependencies();
    const {deps, state} = dependencies({repository: {
      ...base.deps.repository,
      getPhoneNumber: async () => ({
        id: phoneId, restaurantId, e164: '+14165550123',
        telnyxNumberId: 'telnyx-number-1', status: 'released',
      }),
    }});
    const response = await createReleaseNumberHandler(deps)(request('/api/telnyx/numbers/release', {
      phoneNumberId: phoneId, reason: 'Retry',
    }));
    expect(response.status).toBe(200);
    expect(state.releases).toEqual([]);
    expect(state.updated).toEqual([]);
  });

  it('assigns an owned number to the configured TeXML app', async () => {
    const {deps, state} = dependencies();
    const response = await createAssignNumberHandler(deps)(request('/api/telnyx/numbers/assign', {
      phoneNumberId: phoneId,
    }));
    expect(response.status).toBe(200);
    expect(state.assignments).toEqual([['telnyx-number-1', 'texml-app-1']]);
    expect(state.updated).toEqual([{id: phoneId, value: {status: 'active'}}]);
  });

  it('reports forwarding verification only from persisted call evidence', async () => {
    const base = dependencies();
    const {deps} = dependencies({repository: {
      ...base.deps.repository,
      getPhoneNumber: async () => ({
        id: phoneId, restaurantId, e164: '+14165550123', telnyxNumberId: 'telnyx-number-1',
        status: 'active', forwardingVerifiedAt: '2026-10-27T12:00:00.000Z',
      }),
    }});
    const response = await createVerifyForwardingHandler(deps)(request('/api/telnyx/numbers/verify-forwarding', {
      phoneNumberId: phoneId,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      verified: true, verifiedAt: '2026-10-27T12:00:00.000Z',
    });
  });

  it('rejects a phone resource owned by another organization', async () => {
    const base = dependencies();
    const {deps, state} = dependencies({repository: {
      ...base.deps.repository,
      findRestaurantOrganizationId: async () => '00000000-0000-4000-8000-000000000099',
    }});
    const response = await createReleaseNumberHandler(deps)(request('/api/telnyx/numbers/release', {
      phoneNumberId: phoneId, reason: 'No longer needed',
    }));
    expect(response.status).toBe(403);
    expect(state.releases).toEqual([]);
  });

  it('returns a uniform provider error and performs no persistence', async () => {
    const {deps, state} = dependencies({telnyx: {
      ...dependencies().deps.telnyx,
      orderNumber: async () => { throw new Error('provider unavailable'); },
    }});
    const response = await createBuyNumberHandler(deps)(request('/api/telnyx/numbers/buy', {
      restaurantId, phoneNumber: '+14165550123',
    }));
    expect(response.status).toBe(502);
    expect((await error(response)).error.code).toBe('PROVIDER_ERROR');
    expect(state.saved).toEqual([]);
    expect(state.audits).toEqual([]);
  });
});
