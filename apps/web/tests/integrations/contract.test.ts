import {createHmac, generateKeyPairSync, sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

import {dispatchMockRequest, mockFetch} from '@/app/api/_mock/_lib/dispatcher';
import {GET as telnyxGet} from '@/app/api/%5Fmock/telnyx/[...path]/route';
import {
  createFirecrawlClient,
  createGeminiClient,
  createResendClient,
  createSonioxClient,
  createStripeClient,
  createTelnyxClient,
  verifyResendWebhook,
  verifyStripeWebhook,
  verifyTelnyxWebhook,
} from '@/lib/integrations';
import {liveSmokeDecision} from './live-smoke-plan';

describe('integration mock HTTP boundary', () => {
  it('serves fixture bodies without repository-only metadata', async () => {
    const response = await dispatchMockRequest(
      new Request('http://mock.local/api/_mock/telnyx/available_phone_numbers'),
      'telnyx',
      {nodeEnv: 'development'},
    );

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toHaveProperty('data');
    expect(body).not.toHaveProperty('_source');
    expect(body).not.toHaveProperty('_provenance');
  });

  it('keeps mock APIs unavailable in production', async () => {
    const response = await dispatchMockRequest(
      new Request('http://mock.local/api/_mock/stripe/v1/invoices'),
      'stripe',
      {nodeEnv: 'production'},
    );

    expect(response.status).toBe(404);
  });

  it('rejects a wrong method instead of serving another operation fixture', async () => {
    const response = await dispatchMockRequest(
      new Request('http://mock.local/api/_mock/resend/emails', {method: 'GET'}),
      'resend',
      {nodeEnv: 'development'},
    );

    expect(response.status).toBe(405);
  });

  it('routes a fetch request through the same dispatcher used by route handlers', async () => {
    const response = await mockFetch(
      'http://mock.local/api/_mock/firecrawl/scrape',
      {method: 'POST', body: '{}'},
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({success: true});
  });

  it('exposes the dispatcher through a Next route handler', async () => {
    const response = await telnyxGet(
      new Request('http://mock.local/api/_mock/telnyx/available_phone_numbers'),
    );

    expect(response.status).toBe(200);
  });
});

describe('live smoke safety plan', () => {
  it('skips providers with missing credentials and mutations without explicit opt-in', () => {
    expect(liveSmokeDecision('telnyx', {})).toEqual({run: false, reason: 'missing TELNYX_API_KEY'});
    expect(liveSmokeDecision('telnyx', {TELNYX_API_KEY: 'present'})).toEqual({
      run: true, allowMutations: false,
    });
    expect(liveSmokeDecision('stripe', {
      STRIPE_SECRET_KEY: 'present', LIVE_SMOKE_ALLOW_MUTATIONS: '1',
    })).toEqual({run: true, allowMutations: true});
  });
});

describe('all provider clients against fixture-backed mock routes', () => {
  it('validates all Telnyx operation responses', async () => {
    const client = createTelnyxClient({
      apiKey: 'mock-key', baseUrl: 'http://mock.local/api/_mock/telnyx', fetch: mockFetch,
    });
    await expect(client.searchNumbers({areaCode: '416'})).resolves.toMatchObject({data: expect.any(Array)});
    await expect(client.orderNumber({phoneNumber: '+14165550123'})).resolves.toMatchObject({data: {record_type: 'number_order'}});
    await expect(client.listNumbers()).resolves.toMatchObject({data: expect.any(Array)});
    await expect(client.releaseNumber('number-id')).resolves.toMatchObject({data: {status: 'deleted'}});
    await expect(client.assignToTeXmlApp('number-id', 'app-id')).resolves.toMatchObject({data: {record_type: 'phone_number'}});
    await expect(client.sendSms(
      {from: '+14165550100', to: '+14165550101', text: 'Test'},
      {idempotencyKey: 'mock-message-key'},
    )).resolves.toMatchObject({data: {record_type: 'message'}});
  });

  it('validates all Stripe operation responses', async () => {
    const client = createStripeClient({
      apiKey: 'sk_test_mock', baseUrl: 'http://mock.local/api/_mock/stripe', fetch: mockFetch,
    });
    await expect(client.createCustomer(
      {name: 'Test Restaurant', restaurantId: 'rest_test'},
      {idempotencyKey: 'mock-customer-key'},
    )).resolves.toMatchObject({object: 'customer'});
    await expect(client.createCheckoutSession({
      customerId: 'cus_test', basePriceId: 'price_base', meteredPriceId: 'price_metered',
      successUrl: 'https://example.test/success', cancelUrl: 'https://example.test/cancel',
      restaurantId: 'rest_test',
    }, {idempotencyKey: 'mock-checkout-key'})).resolves.toMatchObject({mode: 'subscription'});
    await expect(client.createPortalSession(
      {customerId: 'cus_test', returnUrl: 'https://example.test/account'},
      {idempotencyKey: 'mock-portal-key'},
    )).resolves.toMatchObject({object: 'billing_portal.session'});
    await expect(client.listInvoices({customerId: 'cus_test'})).resolves.toMatchObject({object: 'list'});
    await expect(client.createMeterEvent({
      eventName: 'call_minutes', customerId: 'cus_test', value: '1.5', identifier: 'call_test:final',
    }, {idempotencyKey: 'mock-meter-key'})).resolves.toMatchObject({object: 'billing.meter_event'});
    const account = await client.createStandardAccount(
      {restaurantId: 'rest_test'},
      {idempotencyKey: 'mock-connect-account'},
    );
    await expect(client.retrieveAccount({accountId: account.id})).resolves.toMatchObject({object: 'account', type: 'standard'});
    await expect(client.createAccountOnboardingLink({
      accountId: account.id,
      refreshUrl: 'https://example.test/settings?stripe=refresh',
      returnUrl: 'https://example.test/settings?stripe=return',
    }, {idempotencyKey: 'mock-connect-link'})).resolves.toMatchObject({object: 'account_link'});
    await expect(client.createConnectedPaymentLink({
      connectedAccountId: account.id,
      currency: 'cad',
      amountCents: 4_275,
      productName: 'Order payment',
      restaurantId: 'rest_test',
      target: {kind: 'order', id: 'order-1'},
    }, {idempotencyKey: 'call-1:order-1'})).resolves.toMatchObject({object: 'payment_link'});
  });

  it('validates the Resend send response', async () => {
    const client = createResendClient({
      apiKey: 'mock-key', baseUrl: 'http://mock.local/api/_mock/resend', fetch: mockFetch,
    });
    await expect(client.sendEmail({
      from: 'sender@example.test', to: 'owner@example.test', subject: 'Test', text: 'Test',
    }, {idempotencyKey: 'mock-email-key'})).resolves.toMatchObject({id: expect.any(String)});
  });

  it('validates every Firecrawl response and both polling paths', async () => {
    let now = 0;
    const client = createFirecrawlClient({
      apiKey: 'mock-key', baseUrl: 'http://mock.local/api/_mock/firecrawl', fetch: mockFetch,
      now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
    });
    await expect(client.scrape({url: 'https://example.test'})).resolves.toMatchObject({success: true});
    await expect(client.startCrawl({url: 'https://example.test'})).resolves.toMatchObject({success: true, id: expect.any(String)});
    await expect(client.getCrawl('crawl-id')).resolves.toMatchObject({status: 'completed'});
    await expect(client.map({url: 'https://example.test'})).resolves.toMatchObject({success: true, links: expect.any(Array)});
    await expect(client.startExtract({urls: ['https://example.test'], prompt: 'menu'})).resolves.toMatchObject({success: true});
    await expect(client.getExtract('extract-id')).resolves.toMatchObject({status: 'completed'});
    await expect(client.pollCrawl('crawl-id', {timeoutMs: 1, intervalMs: 1})).resolves.toMatchObject({status: 'completed'});
    await expect(client.pollExtract('extract-id', {timeoutMs: 1, intervalMs: 1})).resolves.toMatchObject({status: 'completed'});
  });

  it('validates a fixture-derived Gemini structured extraction', async () => {
    const client = createGeminiClient({
      apiKey: 'mock-key', model: 'fixture-model',
      baseUrl: 'http://mock.local/api/_mock/gemini', fetch: mockFetch,
    });
    await expect(client.generateStructured({
      prompt: 'Extract a message', schema: {type: 'object', properties: {message: {type: 'string'}}},
    })).resolves.toMatchObject({json: {message: expect.any(String)}});
  });

  it('returns schema-shaped empty collections for the import extraction mock', async () => {
    const client = createGeminiClient({
      apiKey: 'mock-key', model: 'fixture-model',
      baseUrl: 'http://mock.local/api/_mock/gemini', fetch: mockFetch,
    });
    await expect(client.generateStructured({
      prompt: 'Extract restaurant data',
      schema: {
        type: 'object',
        properties: {
          menu: {type: 'array', items: {type: 'object'}},
          hours: {type: 'array', items: {type: 'object'}},
          faqs: {type: 'array', items: {type: 'object'}},
        },
        required: ['menu', 'hours', 'faqs'],
      },
    })).resolves.toMatchObject({json: {menu: [], hours: [], faqs: []}});
  });

  it('validates every Soniox REST response including binary TTS', async () => {
    const client = createSonioxClient({
      apiKey: 'mock-key', baseUrl: 'http://mock.local/api/_mock/soniox',
      ttsPath: '/tts', fetch: mockFetch,
    });
    await expect(client.listModels()).resolves.toMatchObject({models: expect.any(Array)});
    await expect(client.listTtsModels()).resolves.toMatchObject({models: expect.any(Array)});
    await expect(client.listSharedVoices('tts-rt-v2')).resolves.toMatchObject({voices: expect.any(Array)});
    const preview = await client.previewTts({
      model: 'tts-rt-v2', language: 'en', voice: 'fixture-voice', audio_format: 'pcm_s16le', text: 'Test',
    });
    expect(preview.audio.byteLength).toBeGreaterThan(0);
    expect(preview.contentType).toBe('application/octet-stream');
  });

  it('verifies the Stripe fixture vector and deterministic Telnyx/Resend vectors', () => {
    const stripeVector = JSON.parse(readFileSync(
      new URL('../../../../docs/api/stripe/fixtures/webhook.signature.test_vector.json', import.meta.url),
      'utf8',
    )) as {secret: string; timestamp: number; raw_body: string; stripe_signature_header: string};
    expect(verifyStripeWebhook({
      rawBody: stripeVector.raw_body, signatureHeader: stripeVector.stripe_signature_header,
      secret: stripeVector.secret, nowSeconds: stripeVector.timestamp,
    })).toBe(true);

    const {privateKey, publicKey} = generateKeyPairSync('ed25519');
    const timestamp = 1_800_000_000;
    const rawBody = '{"data":{"id":"contract-event"}}';
    const telnyxSignature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64');
    const telnyxPublicKey = publicKey.export({format: 'der', type: 'spki'}).subarray(-32).toString('base64');
    expect(verifyTelnyxWebhook({
      rawBody, signature: telnyxSignature, timestamp: String(timestamp),
      publicKey: telnyxPublicKey, nowSeconds: timestamp,
    })).toBe(true);

    const secretBytes = Buffer.from('contract-resend-secret');
    const secret = `whsec_${secretBytes.toString('base64url')}`;
    const svixId = 'msg_contract';
    const resendSignature = createHmac('sha256', secretBytes)
      .update(`${svixId}.${timestamp}.${rawBody}`).digest('base64');
    expect(verifyResendWebhook({
      rawBody, svixId, svixTimestamp: String(timestamp), svixSignature: `v1,${resendSignature}`,
      secret, nowSeconds: timestamp,
    })).toBe(true);
  });
});
