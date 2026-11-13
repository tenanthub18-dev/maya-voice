import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';

import {authorizeApiRequest} from '@/lib/api/auth';
import {apiError} from '@/lib/api/errors';
import {
  InMemoryFixedWindowRateLimiter,
  SupabaseFixedWindowRateLimiter,
  TokenBucketRateLimiter,
} from '@/lib/api/rate-limit';
import {parseJsonBody} from '@/lib/api/request';
import {webhookCredential} from '@/lib/api/webhook-config';
import {MockApiRepository} from '@/lib/api/mock-repository';

describe('API response contract', () => {
  it('returns the uniform error envelope', async () => {
    const response = apiError('INVALID_REQUEST', 'Request body is invalid', 400);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: {code: 'INVALID_REQUEST', message: 'Request body is invalid'}});
  });

  it('rejects malformed JSON and schema mismatches with stable codes', async () => {
    const schema = z.object({name: z.string().min(1)});
    const malformed = await parseJsonBody(new Request('http://local', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{'}), schema);
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(await malformed.response.json()).toEqual({error: {code: 'INVALID_JSON', message: 'Request body must be valid JSON'}});

    const mismatch = await parseJsonBody(new Request('http://local', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{}'}), schema);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(await mismatch.response.json()).toEqual({error: {code: 'INVALID_REQUEST', message: 'Request body is invalid'}});
  });

  it('rejects cross-origin, non-JSON, and oversized mutation bodies before parsing', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
    const schema = z.object({name: z.string()}).strict();
    const crossOrigin = await parseJsonBody(new Request('https://app.example.com/api/test', {
      method: 'POST', headers: {'content-type': 'application/json', origin: 'https://attacker.example'},
      body: JSON.stringify({name: 'test'}),
    }), schema);
    const wrongType = await parseJsonBody(new Request('https://app.example.com/api/test', {
      method: 'POST', headers: {origin: 'https://app.example.com', 'content-type': 'text/plain'}, body: '{}',
    }), schema);
    const oversized = await parseJsonBody(new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: {origin: 'https://app.example.com', 'content-type': 'application/json', 'content-length': '70000'},
      body: '{}',
    }), schema);
    const streamedOversized = await parseJsonBody(new Request('https://app.example.com/api/test', {
      method: 'POST',
      headers: {origin: 'https://app.example.com', 'content-type': 'application/json'},
      body: JSON.stringify({name: 'a'.repeat(70_000)}),
    }), schema);

    expect(crossOrigin.ok).toBe(false);
    if (!crossOrigin.ok) expect(crossOrigin.response.status).toBe(403);
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.response.status).toBe(415);
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.response.status).toBe(413);
    expect(streamedOversized.ok).toBe(false);
    if (!streamedOversized.ok) expect(streamedOversized.response.status).toBe(413);
    vi.unstubAllEnvs();
  });

  it('rejects unknown JSON keys through strict schemas', async () => {
    const parsed = await parseJsonBody(new Request('http://local', {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({name: 'ok', admin: true}),
    }), z.object({name: z.string()}).strict());
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(400);
  });
});

describe('mock API repository', () => {
  it('keeps route state in memory without requiring Supabase credentials', async () => {
    const repository = new MockApiRepository();
    expect(await repository.findRestaurantOrganizationId('11111111-1111-4111-8111-111111111111'))
      .toBe('22222222-2222-4222-8222-222222222222');
    const job = await repository.createImportJob({status: 'processing'});
    expect(typeof job.id).toBe('string');
    expect(await repository.getImportJob(String(job.id))).toMatchObject({status: 'processing'});
  });

  it('shares diner-payment state with the dev data source synchronously', async () => {
    const {createMockDataSource} = await import('@/lib/data/mock');
    const source = createMockDataSource();
    const restaurant = await source.getRestaurant();
    const order = (await source.listOrders())[0]!;
    const repository = new MockApiRepository(() => source);
    await source.setFeatureFlag('diner_payments', restaurant.id, true);
    await repository.setRestaurantConnectedAccount(restaurant.id, 'acct_mock_connected');

    const started = Date.now();
    expect(await repository.isDinerPaymentsEnabled(restaurant.id)).toBe(true);
    await expect(repository.getPaymentTarget({restaurantId: restaurant.id, kind: 'order', id: order.id}))
      .resolves.toMatchObject({amountCents: order.totalCents, connectedAccountId: 'acct_mock_connected'});
    await expect(repository.markPaymentPaid('acct_mock_connected', 'order', order.id)).resolves.toBe('applied');
    expect((await source.listOrders()).find((row) => row.id === order.id)?.paidStatus).toBe('paid');
    await expect(repository.markPaymentPaid('acct_mock_connected', 'order', order.id)).resolves.toBe('stale');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe('API authorization', () => {
  it('distinguishes unauthenticated users from the wrong role', async () => {
    const signedOut = await authorizeApiRequest(['owner'], async () => null);
    expect(signedOut.ok).toBe(false);
    if (!signedOut.ok) expect(signedOut.response.status).toBe(401);

    const staff = await authorizeApiRequest(['owner'], async () => ({id: 'u', email: 'u@example.com', role: 'staff', organizationId: 'o'}));
    expect(staff.ok).toBe(false);
    if (!staff.ok) {
      expect(staff.response.status).toBe(403);
      expect(await staff.response.json()).toEqual({error: {code: 'FORBIDDEN', message: 'Insufficient permissions'}});
    }
  });

  it('returns an allowed owner identity', async () => {
    const user = {id: 'u', email: 'u@example.com', role: 'owner' as const, organizationId: 'o'};
    expect(await authorizeApiRequest(['owner'], async () => user)).toEqual({ok: true, user});
  });
});

describe('token bucket', () => {
  it('limits keys independently and refills with an injected clock', () => {
    let now = 0;
    const limiter = new TokenBucketRateLimiter({capacity: 2, refillPerSecond: 1, now: () => now});
    expect(limiter.consume('ip:one')).toEqual({allowed: true, retryAfterSeconds: 0});
    expect(limiter.consume('ip:one')).toEqual({allowed: true, retryAfterSeconds: 0});
    expect(limiter.consume('ip:one')).toEqual({allowed: false, retryAfterSeconds: 1});
    expect(limiter.consume('user:two')).toEqual({allowed: true, retryAfterSeconds: 0});
    now = 1_000;
    expect(limiter.consume('ip:one')).toEqual({allowed: true, retryAfterSeconds: 0});
  });
});

describe('persistent fixed-window limiter', () => {
  it('enforces the exact boundary, isolates keys, and resets after the window', async () => {
    let now = 0;
    const limiter = new InMemoryFixedWindowRateLimiter({now: () => now});
    const input = {scope: 'import', key: 'org-1', limit: 2, windowSeconds: 3_600};

    await expect(limiter.consume(input)).resolves.toEqual({allowed: true, retryAfterSeconds: 0});
    await expect(limiter.consume(input)).resolves.toEqual({allowed: true, retryAfterSeconds: 0});
    await expect(limiter.consume(input)).resolves.toEqual({allowed: false, retryAfterSeconds: 3_600});
    await expect(limiter.consume({...input, key: 'org-2'})).resolves.toEqual({allowed: true, retryAfterSeconds: 0});
    now = 3_600_000;
    await expect(limiter.consume(input)).resolves.toEqual({allowed: true, retryAfterSeconds: 0});
  });

  it('shares state across mock limiter instances when they use the same persistent store', async () => {
    const store = new Map();
    const first = new InMemoryFixedWindowRateLimiter({store, now: () => 0});
    const second = new InMemoryFixedWindowRateLimiter({store, now: () => 0});
    const input = {scope: 'number-purchase', key: 'org-1', limit: 1, windowSeconds: 86_400};

    expect((await first.consume(input)).allowed).toBe(true);
    expect((await second.consume(input)).allowed).toBe(false);
  });

  it('uses the atomic Supabase function and returns its literal decision', async () => {
    const rpc = vi.fn(async () => ({
      data: [{allowed: false, retry_after_seconds: 42}], error: null,
    }));
    const limiter = new SupabaseFixedWindowRateLimiter({rpc});

    await expect(limiter.consume({scope: 'import', key: 'org-1', limit: 10, windowSeconds: 3_600}))
      .resolves.toEqual({allowed: false, retryAfterSeconds: 42});
    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      p_scope: 'import', p_key: 'org-1', p_limit: 10, p_window_seconds: 3_600,
    });
  });
});

describe('webhook credential configuration', () => {
  it('allows a mock credential only outside production', () => {
    expect(webhookCredential('STRIPE_WEBHOOK_SECRET', 'mock-secret', {
      INTEGRATIONS_MODE: 'mock', NODE_ENV: 'test',
    })).toBe('mock-secret');
    expect(() => webhookCredential('STRIPE_WEBHOOK_SECRET', 'mock-secret', {
      INTEGRATIONS_MODE: 'mock', NODE_ENV: 'production',
    })).toThrow('STRIPE_WEBHOOK_SECRET is required');
  });

  it('always prefers an explicitly configured credential', () => {
    expect(webhookCredential('RESEND_WEBHOOK_SECRET', 'mock-secret', {
      INTEGRATIONS_MODE: 'live', NODE_ENV: 'production', RESEND_WEBHOOK_SECRET: 'real-secret',
    })).toBe('real-secret');
  });
});
