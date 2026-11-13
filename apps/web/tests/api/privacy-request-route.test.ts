import {createHmac} from 'node:crypto';

import {describe, expect, it, vi} from 'vitest';

import {createPrivacyRequestHandler} from '@/app/api/privacy-requests/_lib';

const restaurantId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const user = {id: 'user-1', email: 'owner@example.com', role: 'owner' as 'owner' | 'staff', organizationId};

function request(body: unknown) {
  return new Request('http://localhost/api/privacy-requests', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
}

function dependencies() {
  return {
    hashSecret: 'test-secret-one-00000000000000000',
    authorize: vi.fn(async () => ({ok: true as const, user})),
    repository: {
      findRestaurantOrganizationId: vi.fn(async () => organizationId as string | null),
      createPrivacyRequest: vi.fn(async (input: {
        actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
        callerHash: string; callerLast4: string;
      }) => ({
        id: '33333333-3333-4333-8333-333333333333', status: 'received' as const,
        requestType: input.requestType, verification: 'required' as const, dueAt: '2026-11-26T12:00:00.000Z',
      })),
      transitionPrivacyRequest: vi.fn(async () => ({
        id: '33333333-3333-4333-8333-333333333333', status: 'completed' as const,
        requestType: 'export' as const, verification: 'verified' as const, dueAt: '2026-11-26T12:00:00.000Z', result: {bookings: []},
      })),
      listPrivacyRequests: vi.fn(async () => []),
      purgeExpiredPrivacyResults: vi.fn(async () => 0),
      executeRestaurantPrivacyRequest: vi.fn(async (input: {requestType: 'export' | 'delete'}) => ({
        id: 'restaurant-request', status: 'completed' as const, requestType: input.requestType,
        verification: 'verified' as const, dueAt: '2026-10-27T12:00:00.000Z', result: {calls: []},
      })),
    },
  };
}

describe('POST /api/privacy-requests', () => {
  it.each(['export', 'delete'] as const)('creates a durable auditable %s request and returns its request ID', async (requestType) => {
    const deps = dependencies();
    const response = await createPrivacyRequestHandler(deps)(request({
      restaurantId,
      callerPhone: '+14165550123',
      requestType,
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      id: '33333333-3333-4333-8333-333333333333',
      status: 'received',
      requestType,
      verification: 'required',
      dueAt: '2026-11-26T12:00:00.000Z',
    });
    const phoneHash = createHmac('sha256', 'test-secret-one-00000000000000000').update(`${restaurantId}:+14165550123`).digest('hex');
    expect(deps.repository.createPrivacyRequest).toHaveBeenCalledWith({
      actorId: user.id,
      organizationId,
      restaurantId,
      callerHash: phoneHash,
      callerLast4: '0123',
      requestType,
    });
  });

  it('uses a keyed digest so the same caller has a different protected reference under another secret', async () => {
    const first = dependencies();
    const second = {...dependencies(), hashSecret: 'test-secret-two-00000000000000000'};
    await createPrivacyRequestHandler(first)(request({restaurantId, callerPhone: '+14165550123', requestType: 'export'}));
    await createPrivacyRequestHandler(second)(request({restaurantId, callerPhone: '+14165550123', requestType: 'export'}));
    const firstInput = first.repository.createPrivacyRequest.mock.calls[0]![0];
    const secondInput = second.repository.createPrivacyRequest.mock.calls[0]![0];
    expect(firstInput.callerHash).not.toBe(secondInput.callerHash);
    expect(JSON.stringify({callerHash: firstInput.callerHash, callerLast4: firstInput.callerLast4})).not.toContain('+14165550123');
  });

  it('allows staff intake but reserves verification and fulfillment for owners', async () => {
    const deps = dependencies();
    deps.authorize.mockResolvedValue({ok: true as const, user: {...user, role: 'staff' as const}});
    expect((await createPrivacyRequestHandler(deps)(request({restaurantId, callerPhone: '+14165550123', requestType: 'export'}))).status).toBe(202);
    const response = await createPrivacyRequestHandler(deps)(new Request('http://localhost/api/privacy-requests', {
      method: 'PATCH', headers: {'content-type': 'application/json'},
      body: JSON.stringify({requestId: '33333333-3333-4333-8333-333333333333', action: 'verify', verificationMethod: 'callback', verificationReference: 'case-1234'}),
    }));
    expect(response.status).toBe(403);
    expect(deps.repository.transitionPrivacyRequest).not.toHaveBeenCalled();
  });

  it('lists resumable requests for owners but not staff', async () => {
    const deps = dependencies();
    const ownerResponse = await createPrivacyRequestHandler(deps)(new Request('http://localhost/api/privacy-requests'));
    expect(ownerResponse.status).toBe(200);
    expect(deps.repository.purgeExpiredPrivacyResults).toHaveBeenCalledOnce();
    expect(deps.repository.listPrivacyRequests).toHaveBeenCalledWith(user.id, organizationId);
    deps.authorize.mockResolvedValueOnce({ok: true as const, user: {...user, role: 'staff'}});
    expect((await createPrivacyRequestHandler(deps)(new Request('http://localhost/api/privacy-requests'))).status).toBe(403);
  });

  it('maps the serialized database hourly limit to HTTP 429', async () => {
    const deps = dependencies();
    deps.repository.createPrivacyRequest.mockRejectedValueOnce(new Error('PRIVACY_REQUEST_RATE_LIMITED'));
    const response = await createPrivacyRequestHandler(deps)(request({restaurantId, callerPhone: '+14165550123', requestType: 'export'}));
    expect(response.status).toBe(429);
  });

  it('rejects malformed phone numbers and unknown request types without writing audit data', async () => {
    const deps = dependencies();
    const handler = createPrivacyRequestHandler(deps);

    expect((await handler(request({restaurantId, callerPhone: '416-555-0123', requestType: 'export'}))).status).toBe(400);
    expect((await handler(request({restaurantId, callerPhone: '+14165550123', requestType: 'correct'}))).status).toBe(400);
    expect(deps.repository.createPrivacyRequest).not.toHaveBeenCalled();
  });

  it('does not reveal or accept a restaurant outside the signed-in organization', async () => {
    const deps = dependencies();
    deps.repository.findRestaurantOrganizationId.mockResolvedValueOnce('another-organization');

    const response = await createPrivacyRequestHandler(deps)(request({
      restaurantId,
      callerPhone: '+14165550123',
      requestType: 'delete',
    }));

    expect(response.status).toBe(404);
    expect(deps.repository.createPrivacyRequest).not.toHaveBeenCalled();
  });

  it.each(['export', 'delete'] as const)('lets owners execute a tenant-scoped restaurant %s request', async (requestType) => {
    const deps = dependencies();
    const response = await createPrivacyRequestHandler(deps)(request({restaurantId, scope: 'restaurant', requestType, ...(requestType === 'delete' ? {confirmRestaurantDeletion: true} : {})}));
    expect(response.status).toBe(200);
    expect(deps.repository.executeRestaurantPrivacyRequest).toHaveBeenCalledWith({
      actorId: user.id, organizationId, restaurantId, requestType,
    });
    expect(deps.repository.createPrivacyRequest).not.toHaveBeenCalled();
  });

  it('denies staff and cross-tenant restaurant deletion before executing it', async () => {
    const staff = dependencies();
    staff.authorize.mockResolvedValue({ok: true as const, user: {...user, role: 'staff' as const}});
    expect((await createPrivacyRequestHandler(staff)(request({restaurantId, scope: 'restaurant', requestType: 'delete', confirmRestaurantDeletion: true}))).status).toBe(403);
    expect(staff.repository.executeRestaurantPrivacyRequest).not.toHaveBeenCalled();

    const foreign = dependencies();
    foreign.repository.findRestaurantOrganizationId.mockResolvedValue('another-organization');
    expect((await createPrivacyRequestHandler(foreign)(request({restaurantId, scope: 'restaurant', requestType: 'delete', confirmRestaurantDeletion: true}))).status).toBe(404);
    expect(foreign.repository.executeRestaurantPrivacyRequest).not.toHaveBeenCalled();
  });

  it('rejects restaurant deletion without an explicit irreversible-action acknowledgement', async () => {
    const deps = dependencies();
    const response = await createPrivacyRequestHandler(deps)(request({restaurantId, scope: 'restaurant', requestType: 'delete'}));
    expect(response.status).toBe(400);
    expect(deps.repository.executeRestaurantPrivacyRequest).not.toHaveBeenCalled();
  });

  it('returns the authorization response before parsing or storing the request', async () => {
    const deps = dependencies();
    const authorize = vi.fn(async () => ({
      ok: false as const,
      response: Response.json({error: {code: 'UNAUTHORIZED', message: 'Authentication required'}}, {status: 401}),
    }));

    const response = await createPrivacyRequestHandler({...deps, authorize})(request({}));

    expect(response.status).toBe(401);
    expect(deps.repository.createPrivacyRequest).not.toHaveBeenCalled();
  });

  it('requires verification before fulfillment and returns the completed export', async () => {
    const deps = dependencies();
    const handler = createPrivacyRequestHandler(deps);
    const requestId = '33333333-3333-4333-8333-333333333333';

    const verifyResponse = await handler(new Request('http://localhost/api/privacy-requests', {
      method: 'PATCH', headers: {'content-type': 'application/json'},
      body: JSON.stringify({requestId, action: 'verify', verificationMethod: 'callback', verificationReference: 'case-1234'}),
    }));
    expect(verifyResponse.status).toBe(200);
    expect(deps.repository.transitionPrivacyRequest).toHaveBeenCalledWith({
      actorId: user.id, organizationId, requestId, action: 'verify', reason: undefined,
      verificationMethod: 'callback', verificationReference: 'case-1234',
    });

    const fulfillResponse = await handler(new Request('http://localhost/api/privacy-requests', {
      method: 'PATCH', headers: {'content-type': 'application/json'},
      body: JSON.stringify({requestId, action: 'fulfill', restaurantId, callerPhone: '+14165550123'}),
    }));
    expect(fulfillResponse.status).toBe(200);
    await expect(fulfillResponse.json()).resolves.toMatchObject({status: 'completed', result: {bookings: []}});
  });

  it('maps an invalid lifecycle transition to conflict', async () => {
    const deps = dependencies();
    deps.repository.transitionPrivacyRequest.mockRejectedValueOnce(new Error('PRIVACY_REQUEST_NOT_VERIFIED'));
    const response = await createPrivacyRequestHandler(deps)(new Request('http://localhost/api/privacy-requests', {
      method: 'PATCH', headers: {'content-type': 'application/json'},
      body: JSON.stringify({requestId: '33333333-3333-4333-8333-333333333333', action: 'fulfill', restaurantId, callerPhone: '+14165550123'}),
    }));
    expect(response.status).toBe(409);
  });

  it('returns a retryable conflict when a late recording has not been removed', async () => {
    const deps = dependencies();
    deps.repository.transitionPrivacyRequest.mockRejectedValueOnce(new Error('PRIVACY_REQUEST_RECORDINGS_PENDING'));
    const response = await createPrivacyRequestHandler(deps)(new Request('http://localhost/api/privacy-requests', {
      method: 'PATCH', headers: {'content-type': 'application/json'},
      body: JSON.stringify({requestId: '33333333-3333-4333-8333-333333333333', action: 'fulfill', restaurantId, callerPhone: '+14165550123'}),
    }));
    expect(response.status).toBe(409);
  });
});
