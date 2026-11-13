import {describe, expect, it, vi} from 'vitest';

import {createPaymentLinkHandler} from '@/app/api/payments/link/_lib';
import {paymentLinkCredential} from '@/app/api/payments/link/_config';
import {signWorkerRequest} from '@/lib/security/worker-hmac';

const path = '/api/payments/link';
const secret = 'worker-secret';
const now = 1_700_000_000;

function signedRequest(bodyValue: Record<string, unknown>) {
  const body = JSON.stringify(bodyValue);
  const timestamp = String(now);
  const {signature} = signWorkerRequest({secret, timestamp, method: 'POST', path, body});
  return new Request(`https://app.test${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-timestamp': timestamp, 'x-signature': signature},
    body,
  });
}

type Target = {
  kind: 'order' | 'booking'; id: string; restaurantId: string;
  amountCents: number; connectedAccountId: string | null;
  paidStatus: 'unpaid' | 'paid' | 'refunded';
};

function dependencies(options: {enabled?: boolean; target?: Target | null} = {}) {
  const repository = {
    getPaymentTarget: vi.fn(async () => options.target === undefined ? ({
      kind: 'order' as const,
      id: 'order-1',
      restaurantId: 'rest-1',
      amountCents: 4_275,
      paidStatus: 'unpaid' as const,
      connectedAccountId: 'acct_123',
    }) : options.target),
  };
  const stripe = {createConnectedPaymentLink: vi.fn(async () => ({url: 'https://buy.stripe.test/link'}))};
  return {repository, stripe, deps: {
    repository,
    stripe,
    secret,
    nowSeconds: () => now,
    isEnabled: async () => options.enabled ?? true,
  }};
}

describe('internal payment link route', () => {
  it('never uses predictable credential fallbacks in production', () => {
    expect(() => paymentLinkCredential('WORKER_HMAC_SECRET', {
      NODE_ENV: 'production', INTEGRATIONS_MODE: 'mock',
    })).toThrow(/WORKER_HMAC_SECRET/u);
    expect(paymentLinkCredential('WORKER_HMAC_SECRET', {
      NODE_ENV: 'development', INTEGRATIONS_MODE: 'mock',
    })).toBe('mock-worker_hmac_secret');
    expect(paymentLinkCredential('WORKER_HMAC_SECRET', {
      NODE_ENV: 'production', INTEGRATIONS_MODE: 'mock', WORKER_HMAC_SECRET: 'secret-production',
    })).toBe('secret-production');
  });

  it('refuses with typed feature_disabled before reading payment data', async () => {
    const {deps, repository} = dependencies({enabled: false});
    const response = await createPaymentLinkHandler(deps)(signedRequest({
      restaurant_id: 'rest-1', call_id: 'call-1', order_id: 'order-1',
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({error: {code: 'feature_disabled', message: 'Diner payments are disabled'}});
    expect(repository.getPaymentTarget).not.toHaveBeenCalled();
  });

  it('uses only the stored order total and stable call+target idempotency key', async () => {
    const {deps, stripe} = dependencies();
    const response = await createPaymentLinkHandler(deps)(signedRequest({
      restaurant_id: 'rest-1', call_id: 'call-1', order_id: 'order-1',
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({url: 'https://buy.stripe.test/link', target_id: 'order-1'});
    expect(stripe.createConnectedPaymentLink).toHaveBeenCalledWith({
      connectedAccountId: 'acct_123',
      amountCents: 4_275,
      currency: 'cad',
      productName: 'Order order-1',
      restaurantId: 'rest-1',
      target: {kind: 'order', id: 'order-1'},
    }, {idempotencyKey: 'call-1:order-1'});
  });

  it('rejects an LLM-supplied amount instead of accepting it', async () => {
    const {deps, repository} = dependencies();
    const response = await createPaymentLinkHandler(deps)(signedRequest({
      restaurant_id: 'rest-1', call_id: 'call-1', order_id: 'order-1', amount_cents: 1,
    }));
    expect(response.status).toBe(400);
    expect(repository.getPaymentTarget).not.toHaveBeenCalled();
  });

  it('returns not_found when the target is not owned by the restaurant', async () => {
    const {deps, stripe} = dependencies({target: null});
    const response = await createPaymentLinkHandler(deps)(signedRequest({
      restaurant_id: 'rest-2', call_id: 'call-1', order_id: 'order-1',
    }));
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({error: {code: 'not_found'}});
    expect(stripe.createConnectedPaymentLink).not.toHaveBeenCalled();
  });

  it('refuses to create another link for an already-paid target', async () => {
    const {deps, stripe} = dependencies({target: {
      kind: 'order', id: 'order-1', restaurantId: 'rest-1', amountCents: 4_275,
      connectedAccountId: 'acct_123', paidStatus: 'paid',
    }});
    const response = await createPaymentLinkHandler(deps)(signedRequest({
      restaurant_id: 'rest-1', call_id: 'call-2', order_id: 'order-1',
    }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({error: {code: 'already_paid'}});
    expect(stripe.createConnectedPaymentLink).not.toHaveBeenCalled();
  });

  it('rejects an oversized body before hashing or parsing it', async () => {
    const {deps, repository} = dependencies();
    const response = await createPaymentLinkHandler(deps)(new Request('https://app.test/api/payments/link', {
      method: 'POST', body: 'x'.repeat(16 * 1_024 + 1),
      headers: {'x-timestamp': String(now), 'x-signature': `sha256=${'a'.repeat(64)}`},
    }));
    expect(response.status).toBe(413);
    expect(repository.getPaymentTarget).not.toHaveBeenCalled();
  });
});
