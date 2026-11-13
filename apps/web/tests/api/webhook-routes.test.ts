import {createHmac, generateKeyPairSync, sign} from 'node:crypto';
import {describe, expect, it} from 'vitest';

import {
  createResendWebhookHandler,
  createStripeWebhookHandler,
  createTelnyxSmsWebhookHandler,
  type WebhookRepository,
} from '@/lib/api/webhooks';

class Repository implements WebhookRepository {
  claimed = true;
  completed: Array<[string, string]> = [];
  failed: Array<[string, string, string]> = [];
  billing: Array<[string, Record<string, unknown>]> = [];
  optOuts: Array<[string, string]> = [];
  deliveries: Array<[string, string, string | undefined, unknown]> = [];
  payments: Array<[string, 'order' | 'booking', string]> = [];
  restaurantId: string | null = 'restaurant-1';

  async claimEvent(): Promise<boolean> { return this.claimed; }
  async completeEvent(provider: 'stripe' | 'telnyx-sms' | 'resend', id: string): Promise<void> {
    this.completed.push([provider, id]);
  }
  async failEvent(provider: 'stripe' | 'telnyx-sms' | 'resend', id: string, error: string): Promise<void> {
    this.failed.push([provider, id, error]);
  }
  async updateOrganizationBilling(customer: string | null, value: Record<string, unknown>): Promise<'applied'> {
    if (customer === null) throw new Error('missing customer');
    this.billing.push([customer, value]);
    return 'applied';
  }
  async addSmsOptOut(restaurantId: string, phone: string): Promise<void> {
    if (!this.optOuts.some(([storedRestaurant, storedPhone]) => storedRestaurant === restaurantId && storedPhone === phone)) {
      this.optOuts.push([restaurantId, phone]);
    }
  }
  async removeSmsOptOut(restaurantId: string, phone: string): Promise<void> {
    this.optOuts = this.optOuts.filter(([storedRestaurant, storedPhone]) =>
      storedRestaurant !== restaurantId || storedPhone !== phone);
  }
  async findRestaurantIdByPhoneNumber(): Promise<string | null> { return this.restaurantId; }
  async updateSmsDelivery(id: string, status: 'sent' | 'delivered' | 'failed', at?: string, error?: unknown): Promise<'applied'> {
    this.deliveries.push([id, status, at, error]);
    return 'applied';
  }
  async markPaymentPaid(accountId: string, kind: 'order' | 'booking', targetId: string): Promise<'applied' | 'not_found'> {
    this.payments.push([accountId, kind, targetId]);
    return accountId === 'acct_unknown' ? 'not_found' : 'applied';
  }
}

const allow = {consume: () => ({allowed: true, retryAfterSeconds: 0})};
const deny = {consume: () => ({allowed: false, retryAfterSeconds: 7})};
const now = 1_800_000_000;

function stripeRequest(event: unknown, secret = 'whsec_test'): Request {
  const raw = JSON.stringify(event);
  const signature = createHmac('sha256', secret).update(`${now}.${raw}`).digest('hex');
  return new Request('http://local/api/webhooks/stripe', {
    method: 'POST', body: raw, headers: {'stripe-signature': `t=${now},v1=${signature}`},
  });
}

function stripeEvent(type: string, object: Record<string, unknown>, id = `evt_${type}`) {
  return {id, type, created: now - 1, data: {object}};
}

describe('Stripe webhook', () => {
  it('rejects an oversized public webhook body before signature work', async () => {
    const handler = createStripeWebhookHandler({repository: new Repository(), limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const response = await handler(new Request('http://local/api/webhooks/stripe', {
      method: 'POST', body: 'x'.repeat(1_024 * 1_024 + 1), headers: {'stripe-signature': `t=${now},v1=${'a'.repeat(64)}`},
    }));
    expect(response.status).toBe(413);
  });

  it.each([
    ['checkout.session.completed', {payment_status: 'paid', metadata: {order_id: 'order-1'}}],
    ['payment_intent.succeeded', {metadata: {booking_id: 'booking-1'}}],
  ] as const)('marks a connected-account target paid from %s', async (type, object) => {
    const repository = new Repository();
    const handler = createStripeWebhookHandler({repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const event = {...stripeEvent(type, object), account: 'acct_restaurant'};
    const response = await handler(stripeRequest(event));
    expect(response.status).toBe(200);
    expect(repository.payments).toEqual(type === 'checkout.session.completed'
      ? [['acct_restaurant', 'order', 'order-1']]
      : [['acct_restaurant', 'booking', 'booking-1']]);
    expect(repository.completed).toEqual([['stripe', `evt_${type}`]]);
  });

  it('acknowledges an unknown connected account with generic success and no billing mutation', async () => {
    const repository = new Repository();
    const handler = createStripeWebhookHandler({repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const event = {...stripeEvent('payment_intent.succeeded', {metadata: {order_id: 'order-1'}}), account: 'acct_unknown'};
    const response = await handler(stripeRequest(event));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({received: true});
    expect(repository.billing).toEqual([]);
    expect(repository.completed).toEqual([['stripe', 'evt_payment_intent.succeeded']]);
  });

  it('does not acknowledge delivery until the paid-status database write finishes', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const repository = new Repository();
    repository.markPaymentPaid = async () => { await pending; return 'applied'; };
    const handler = createStripeWebhookHandler({repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const event = {...stripeEvent('payment_intent.succeeded', {metadata: {order_id: 'order-1'}}), account: 'acct_restaurant'};
    let settled = false;
    const responsePromise = handler(stripeRequest(event)).then((response) => { settled = true; return response; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect((await responsePromise).status).toBe(200);
  });
  it.each([
    ['checkout.session.completed', {customer: 'cus_1', subscription: 'sub_1', metadata: {restaurant_id: 'restaurant-1'}}, {stripe_customer_id: 'cus_1', stripe_subscription_id: 'sub_1'}],
    ['customer.subscription.created', {id: 'sub_1', customer: 'cus_1', status: 'active'}, {stripe_subscription_id: 'sub_1', stripe_subscription_status: 'active'}],
    ['customer.subscription.updated', {id: 'sub_1', customer: 'cus_1', status: 'past_due'}, {stripe_subscription_status: 'past_due'}],
    ['customer.subscription.deleted', {id: 'sub_1', customer: 'cus_1', status: 'canceled'}, {stripe_subscription_status: 'canceled'}],
    ['invoice.paid', {id: 'in_1', customer: 'cus_1'}, {last_invoice_id: 'in_1', last_invoice_status: 'paid'}],
    ['invoice.payment_failed', {id: 'in_1', customer: 'cus_1'}, {last_invoice_id: 'in_1', last_invoice_status: 'payment_failed'}],
    ['billing.alert.triggered', {customer: 'cus_1'}, {}],
  ])('maps %s with an ordering timestamp', async (type, object, expected) => {
    const repository = new Repository();
    const handler = createStripeWebhookHandler({repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const response = await handler(stripeRequest(stripeEvent(type, object)));
    expect(response.status).toBe(200);
    expect(repository.billing).toHaveLength(1);
    expect(repository.billing[0]?.[0]).toBe('cus_1');
    expect(repository.billing[0]?.[1]).toMatchObject(expected);
    expect(Object.keys(repository.billing[0]?.[1] ?? {}).some((key) => key.endsWith('_event_created_at'))).toBe(true);
    expect(Object.keys(repository.billing[0]?.[1] ?? {}).some((key) => key.endsWith('_event_id'))).toBe(true);
    expect(repository.completed[0]).toEqual(['stripe', `evt_${type}`]);
  });

  it('rejects invalid signatures and signed malformed events', async () => {
    const repository = new Repository();
    const handler = createStripeWebhookHandler({repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const bad = stripeRequest(stripeEvent('invoice.paid', {id: 'in_1', customer: 'cus_1'}), 'wrong');
    expect((await handler(bad)).status).toBe(400);
    const raw = JSON.stringify(stripeEvent('invoice.paid', {id: 'in_1', customer: 'cus_1'}));
    const staleTimestamp = now - 301;
    const staleSignature = createHmac('sha256', 'whsec_test')
      .update(`${staleTimestamp}.${raw}`).digest('hex');
    const stale = new Request('http://local/api/webhooks/stripe', {
      method: 'POST', body: raw,
      headers: {'stripe-signature': `t=${staleTimestamp},v1=${staleSignature}`},
    });
    expect((await handler(stale)).status).toBe(400);
    const malformed = stripeRequest({id: 'evt_bad', type: 'invoice.paid'});
    const response = await handler(malformed);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({error: {code: 'INVALID_EVENT', message: 'Webhook event is invalid'}});
  });

  it('returns success for duplicate deliveries without applying mutations', async () => {
    const repository = new Repository();
    repository.claimed = false;
    const handler = createStripeWebhookHandler({repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now});
    const response = await handler(stripeRequest(stripeEvent('invoice.paid', {id: 'in_1', customer: 'cus_1'})));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({received: true, duplicate: true});
    expect(repository.billing).toEqual([]);
  });

  it('acknowledges an unverified billing alert shape without an unsafe mutation', async () => {
    const repository = new Repository();
    const handler = createStripeWebhookHandler({
      repository, limiter: allow, secret: 'whsec_test', nowSeconds: () => now,
    });
    const response = await handler(stripeRequest(stripeEvent('billing.alert.triggered', {})));
    expect(response.status).toBe(200);
    expect(repository.billing).toEqual([]);
    expect(repository.completed).toEqual([['stripe', 'evt_billing.alert.triggered']]);
  });

  it('rate limits by source IP with the uniform error envelope', async () => {
    const handler = createStripeWebhookHandler({repository: new Repository(), limiter: deny, secret: 'whsec_test', nowSeconds: () => now});
    const response = await handler(stripeRequest(stripeEvent('invoice.paid', {id: 'in_1', customer: 'cus_1'})));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.json()).toEqual({error: {code: 'RATE_LIMITED', message: 'Too many requests'}});
  });
});

function telnyxSigner() {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const publicKeyBase64 = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64');
  return {
    publicKey: publicKeyBase64,
    request(event: unknown) {
      const raw = JSON.stringify(event);
      const signature = sign(null, Buffer.from(`${now}|${raw}`), privateKey).toString('base64');
      return new Request('http://local/api/webhooks/telnyx-sms', {method: 'POST', body: raw, headers: {
        'telnyx-signature-ed25519': signature, 'telnyx-timestamp': String(now),
      }});
    },
  };
}

function telnyxEvent(eventType: string, payload: Record<string, unknown>) {
  return {data: {id: `event-${eventType}`, event_type: eventType, occurred_at: '2026-10-27T12:00:00.000Z', payload}};
}

describe('Telnyx SMS webhook', () => {
  it.each([
    'STOP', ' stop ', 'stopall', 'STOP ALL', 'unsubscribe', 'CANCEL', 'end', 'QUIT',
    'ARRET', 'Arrêt', 'desabonner', 'Désabonner',
  ])('records the %s opt-out keyword', async (text) => {
    const signer = telnyxSigner();
    const repository = new Repository();
    const handler = createTelnyxSmsWebhookHandler({repository, limiter: allow, publicKey: signer.publicKey, nowSeconds: () => now});
    const event = telnyxEvent('message.received', {
      text, from: {phone_number: '+14165550101'}, to: [{phone_number: '+14165550102'}],
    });
    expect((await handler(signer.request(event))).status).toBe(200);
    expect(repository.optOuts).toEqual([['restaurant-1', '+14165550101']]);
  });

  it.each(['STOP NOW', 'STOPALL NOW', 'ARRETER', 'DESABONNER SVP', ''])
    ('does not record the near-match %s as an opt-out', async (text) => {
      const signer = telnyxSigner();
      const repository = new Repository();
      const handler = createTelnyxSmsWebhookHandler({
        repository, limiter: allow, publicKey: signer.publicKey, nowSeconds: () => now,
      });
      const event = telnyxEvent('message.received', {
        text, from: {phone_number: '+14165550101'}, to: [{phone_number: '+14165550102'}],
      });
      expect((await handler(signer.request(event))).status).toBe(200);
      expect(repository.optOuts).toEqual([]);
    });

  it.each(['START', ' start ', 'UNSTOP', ' unstop '])
    ('re-enables only the addressed restaurant and sender pair for %s', async (text) => {
      const signer = telnyxSigner();
      const repository = new Repository();
      repository.optOuts = [
        ['restaurant-1', '+14165550101'],
        ['restaurant-2', '+14165550101'],
        ['restaurant-1', '+14165550199'],
      ];
      const handler = createTelnyxSmsWebhookHandler({
        repository, limiter: allow, publicKey: signer.publicKey, nowSeconds: () => now,
      });
      const event = telnyxEvent('message.received', {
        text, from: {phone_number: '+14165550101'}, to: [{phone_number: '+14165550102'}],
      });
      expect((await handler(signer.request(event))).status).toBe(200);
      expect(repository.optOuts).toEqual([
        ['restaurant-2', '+14165550101'],
        ['restaurant-1', '+14165550199'],
      ]);
    });

  it.each([
    ['message.sent', {id: 'msg-1', errors: [], to: [{phone_number: '+1', status: 'sent'}]}, 'sent'],
    ['message.finalized', {id: 'msg-1', errors: [], to: [{phone_number: '+1', status: 'delivered'}]}, 'delivered'],
    ['message.finalized', {id: 'msg-1', errors: [{code: '40300'}], to: [{phone_number: '+1', status: 'delivery_failed'}]}, 'failed'],
  ])('maps %s receipts to %s', async (eventType, payload, expected) => {
    const signer = telnyxSigner();
    const repository = new Repository();
    const handler = createTelnyxSmsWebhookHandler({repository, limiter: allow, publicKey: signer.publicKey, nowSeconds: () => now});
    expect((await handler(signer.request(telnyxEvent(eventType, payload)))).status).toBe(200);
    expect(repository.deliveries[0]?.slice(0, 3)).toEqual(['msg-1', expected, '2026-10-27T12:00:00.000Z']);
  });

  it('rejects a bad signature and requires data.id for replay protection', async () => {
    const signer = telnyxSigner();
    const repository = new Repository();
    const handler = createTelnyxSmsWebhookHandler({repository, limiter: allow, publicKey: signer.publicKey, nowSeconds: () => now});
    const unsigned = new Request('http://local/api/webhooks/telnyx-sms', {method: 'POST', body: '{}'});
    expect((await handler(unsigned)).status).toBe(400);
    const incomplete = {data: {event_type: 'message.received', payload: {text: 'STOP'}}};
    expect((await handler(signer.request(incomplete))).status).toBe(400);
  });

  it('acknowledges a replayed event id without repeating SMS side effects', async () => {
    const signer = telnyxSigner();
    const repository = new Repository();
    repository.claimed = false;
    const handler = createTelnyxSmsWebhookHandler({
      repository, limiter: allow, publicKey: signer.publicKey, nowSeconds: () => now,
    });
    const response = await handler(signer.request(telnyxEvent('message.received', {
      text: 'STOP', from: {phone_number: '+14165550101'},
      to: [{phone_number: '+14165550102'}],
    })));
    expect(await response.json()).toEqual({received: true, duplicate: true});
    expect(repository.optOuts).toEqual([]);
  });
});

function resendRequest(event: unknown, secret: string, id = 'msg_1'): Request {
  const raw = JSON.stringify(event);
  const timestamp = String(now);
  const key = Buffer.from(secret.slice(6), 'base64url');
  const signature = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest('base64');
  return new Request('http://local/api/webhooks/resend', {method: 'POST', body: raw, headers: {
    'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}`,
  }});
}

describe('Resend webhook', () => {
  const secret = `whsec_${Buffer.from('resend-test-secret').toString('base64url')}`;

  it('verifies, validates, and deduplicates by svix-id', async () => {
    const repository = new Repository();
    const handler = createResendWebhookHandler({repository, limiter: allow, secret, nowSeconds: () => now});
    const event = {type: 'email.delivered', created_at: '2026-10-27T00:00:00.000Z', data: {email_id: 'email-1', to: ['owner@example.com']}};
    expect((await handler(resendRequest(event, secret))).status).toBe(200);
    expect(repository.completed).toEqual([['resend', 'msg_1']]);
    repository.claimed = false;
    const duplicate = await handler(resendRequest(event, secret));
    expect(await duplicate.json()).toEqual({received: true, duplicate: true});
  });

  it('rejects invalid signatures and malformed payloads', async () => {
    const handler = createResendWebhookHandler({repository: new Repository(), limiter: allow, secret, nowSeconds: () => now});
    expect((await handler(resendRequest({type: 'email.delivered', data: {}}, `${secret}bad`))).status).toBe(400);
    expect((await handler(resendRequest({data: {}}, secret))).status).toBe(400);
  });
});
