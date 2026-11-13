import {randomUUID} from 'node:crypto';

import {createFirecrawlClient} from '../lib/integrations/firecrawl';
import {createGeminiClient} from '../lib/integrations/gemini';
import {getIntegrationsMode, getProviderBaseUrl, type Provider} from '../lib/integrations/mode';
import {createResendClient} from '../lib/integrations/resend';
import {createSonioxClient} from '../lib/integrations/soniox';
import {createStripeClient} from '../lib/integrations/stripe';
import {createTelnyxClient} from '../lib/integrations/telnyx';
import {liveSmokeDecision} from '../tests/integrations/live-smoke-plan';

const env = process.env;

function line(message: string): void {
  process.stdout.write(`${message}\n`);
}

function skipped(provider: Provider, operation: string, reason: string): void {
  line(`SKIP ${provider}/${operation}: ${reason}`);
}

async function run(provider: Provider, operation: string, action: () => Promise<unknown>): Promise<void> {
  await action();
  line(`PASS ${provider}/${operation}`);
}

function mutationsAllowed(provider: Provider): boolean {
  const decision = liveSmokeDecision(provider, env);
  return decision.run && decision.allowMutations;
}

async function smokeTelnyx(): Promise<void> {
  const provider = 'telnyx';
  const decision = liveSmokeDecision(provider, env);
  if (!decision.run) return skipped(provider, 'provider', decision.reason);
  const client = createTelnyxClient({
    apiKey: env.TELNYX_API_KEY!, baseUrl: getProviderBaseUrl(provider, env),
  });
  await run(provider, 'searchNumbers', () => client.searchNumbers({areaCode: env.LIVE_SMOKE_AREA_CODE ?? '416', limit: 1}));
  await run(provider, 'listNumbers', () => client.listNumbers({pageSize: 1}));
  if (!decision.allowMutations) {
    skipped(provider, 'order/release/assign/sendSms', 'set LIVE_SMOKE_ALLOW_MUTATIONS=1 and operation-specific test IDs');
    return;
  }
  const orderNumber = env.LIVE_SMOKE_TELNYX_ORDER_NUMBER;
  if (orderNumber) {
    await run(provider, 'orderNumber', () => client.orderNumber({phoneNumber: orderNumber, customerReference: `smoke-${randomUUID()}`}));
  } else {
    skipped(provider, 'orderNumber', 'missing LIVE_SMOKE_TELNYX_ORDER_NUMBER');
  }
  const releaseId = env.LIVE_SMOKE_TELNYX_RELEASE_ID;
  if (releaseId) {
    await run(provider, 'releaseNumber', () => client.releaseNumber(releaseId));
  } else {
    skipped(provider, 'releaseNumber', 'missing LIVE_SMOKE_TELNYX_RELEASE_ID');
  }
  const numberId = env.LIVE_SMOKE_TELNYX_NUMBER_ID;
  const appId = env.LIVE_SMOKE_TELNYX_TEXML_APP_ID;
  if (numberId && appId) {
    await run(provider, 'assignToTeXmlApp', () => client.assignToTeXmlApp(numberId, appId));
  } else {
    skipped(provider, 'assignToTeXmlApp', 'missing LIVE_SMOKE_TELNYX_NUMBER_ID or LIVE_SMOKE_TELNYX_TEXML_APP_ID');
  }
  const from = env.LIVE_SMOKE_TELNYX_FROM;
  const to = env.LIVE_SMOKE_TELNYX_TO;
  if (from && to) {
    await run(provider, 'sendSms', () => client.sendSms({from, to, text: 'Integration smoke test'}, {idempotencyKey: randomUUID()}));
  } else {
    skipped(provider, 'sendSms', 'missing LIVE_SMOKE_TELNYX_FROM or LIVE_SMOKE_TELNYX_TO');
  }
}

async function smokeStripe(): Promise<void> {
  const provider = 'stripe';
  const decision = liveSmokeDecision(provider, env);
  if (!decision.run) return skipped(provider, 'provider', decision.reason);
  const client = createStripeClient({
    apiKey: env.STRIPE_SECRET_KEY!, baseUrl: getProviderBaseUrl(provider, env),
  });
  const customerId = env.LIVE_SMOKE_STRIPE_CUSTOMER_ID;
  if (customerId) {
    await run(provider, 'listInvoices', () => client.listInvoices({customerId, limit: 1}));
  } else {
    skipped(provider, 'listInvoices', 'missing LIVE_SMOKE_STRIPE_CUSTOMER_ID');
  }
  if (!decision.allowMutations) {
    skipped(provider, 'customer/checkout/portal/meterEvent', 'set LIVE_SMOKE_ALLOW_MUTATIONS=1 and operation-specific test IDs');
    return;
  }
  const restaurantId = env.LIVE_SMOKE_STRIPE_RESTAURANT_ID;
  const customerName = env.LIVE_SMOKE_STRIPE_CUSTOMER_NAME;
  if (customerName && restaurantId) {
    await run(provider, 'createCustomer', () => client.createCustomer({
      name: customerName, email: env.LIVE_SMOKE_STRIPE_CUSTOMER_EMAIL, restaurantId,
    }, {idempotencyKey: randomUUID()}));
  } else {
    skipped(provider, 'createCustomer', 'missing LIVE_SMOKE_STRIPE_CUSTOMER_NAME or LIVE_SMOKE_STRIPE_RESTAURANT_ID');
  }
  const basePriceId = env.LIVE_SMOKE_STRIPE_BASE_PRICE_ID;
  const meteredPriceId = env.LIVE_SMOKE_STRIPE_METERED_PRICE_ID;
  const successUrl = env.LIVE_SMOKE_STRIPE_SUCCESS_URL;
  const cancelUrl = env.LIVE_SMOKE_STRIPE_CANCEL_URL;
  if (customerId && restaurantId && basePriceId && meteredPriceId && successUrl && cancelUrl) {
    await run(provider, 'createCheckoutSession', () => client.createCheckoutSession({
      customerId, restaurantId, basePriceId, meteredPriceId, successUrl, cancelUrl,
    }, {idempotencyKey: randomUUID()}));
  } else {
    skipped(provider, 'createCheckoutSession', 'missing customer, restaurant, price, or return URL smoke IDs');
  }
  const returnUrl = env.LIVE_SMOKE_STRIPE_RETURN_URL;
  if (customerId && returnUrl) {
    await run(provider, 'createPortalSession', () => client.createPortalSession(
      {customerId, returnUrl}, {idempotencyKey: randomUUID()},
    ));
  } else {
    skipped(provider, 'createPortalSession', 'missing LIVE_SMOKE_STRIPE_CUSTOMER_ID or LIVE_SMOKE_STRIPE_RETURN_URL');
  }
  const eventName = env.LIVE_SMOKE_STRIPE_METER_EVENT_NAME;
  if (customerId && eventName) {
    await run(provider, 'createMeterEvent', () => client.createMeterEvent({
      customerId, eventName, value: env.LIVE_SMOKE_STRIPE_METER_VALUE ?? '0',
      identifier: `smoke-${randomUUID()}`,
    }, {idempotencyKey: randomUUID()}));
  } else {
    skipped(provider, 'createMeterEvent', 'missing LIVE_SMOKE_STRIPE_CUSTOMER_ID or LIVE_SMOKE_STRIPE_METER_EVENT_NAME');
  }
}

async function smokeResend(): Promise<void> {
  const provider = 'resend';
  const decision = liveSmokeDecision(provider, env);
  if (!decision.run) return skipped(provider, 'provider', decision.reason);
  if (!decision.allowMutations) return skipped(provider, 'sendEmail', 'set LIVE_SMOKE_ALLOW_MUTATIONS=1 with test sender and recipient');
  const from = env.LIVE_SMOKE_RESEND_FROM;
  const to = env.LIVE_SMOKE_RESEND_TO;
  if (!from || !to) return skipped(provider, 'sendEmail', 'missing LIVE_SMOKE_RESEND_FROM or LIVE_SMOKE_RESEND_TO');
  const client = createResendClient({apiKey: env.RESEND_API_KEY!, baseUrl: getProviderBaseUrl(provider, env)});
  await run(provider, 'sendEmail', () => client.sendEmail({from, to, subject: 'Integration smoke test', text: 'Integration smoke test'}, {idempotencyKey: randomUUID()}));
}

async function smokeFirecrawl(): Promise<void> {
  const provider = 'firecrawl';
  const decision = liveSmokeDecision(provider, env);
  if (!decision.run) return skipped(provider, 'provider', decision.reason);
  if (!decision.allowMutations) return skipped(provider, 'scrape/crawl/map/extract/status', 'set LIVE_SMOKE_ALLOW_MUTATIONS=1 with LIVE_SMOKE_URL; calls consume provider credits');
  const url = env.LIVE_SMOKE_URL;
  if (!url) return skipped(provider, 'scrape/crawl/map/extract/status', 'missing LIVE_SMOKE_URL');
  const client = createFirecrawlClient({apiKey: env.FIRECRAWL_API_KEY!, baseUrl: getProviderBaseUrl(provider, env)});
  await run(provider, 'scrape', () => client.scrape({url, formats: ['markdown']}));
  await run(provider, 'map', () => client.map({url, limit: 1}));
  const crawl = await client.startCrawl({url, limit: 1});
  line('PASS firecrawl/startCrawl');
  await run(provider, 'getCrawl', () => client.getCrawl(crawl.id));
  await run(provider, 'pollCrawl', () => client.pollCrawl(crawl.id, {timeoutMs: 120_000, intervalMs: 2_000}));
  const extract = await client.startExtract({urls: [url], prompt: 'Return the restaurant name'});
  line('PASS firecrawl/startExtract');
  await run(provider, 'getExtract', () => client.getExtract(extract.id));
  await run(provider, 'pollExtract', () => client.pollExtract(extract.id, {timeoutMs: 120_000, intervalMs: 2_000}));
}

async function smokeGemini(): Promise<void> {
  const provider = 'gemini';
  const decision = liveSmokeDecision(provider, env);
  if (!decision.run) return skipped(provider, 'provider', decision.reason);
  if (!decision.allowMutations) return skipped(provider, 'generateStructured', 'set LIVE_SMOKE_ALLOW_MUTATIONS=1; generation consumes paid quota');
  const model = env.GEMINI_MODEL_ID;
  if (!model) return skipped(provider, 'generateStructured', 'missing GEMINI_MODEL_ID');
  const client = createGeminiClient({apiKey: env.GEMINI_API_KEY!, baseUrl: getProviderBaseUrl(provider, env), model});
  await run(provider, 'generateStructured', () => client.generateStructured({
    prompt: 'Return the name Test Restaurant.',
    schema: {type: 'object', properties: {name: {type: 'string'}}, required: ['name']},
    maxOutputTokens: 128,
  }));
}

async function smokeSoniox(): Promise<void> {
  const provider = 'soniox';
  const decision = liveSmokeDecision(provider, env);
  if (!decision.run) return skipped(provider, 'provider', decision.reason);
  const client = createSonioxClient({
    apiKey: env.SONIOX_API_KEY!, baseUrl: getProviderBaseUrl(provider, env),
    ttsPath: env.SONIOX_TTS_PATH!,
  });
  await run(provider, 'listModels', () => client.listModels());
  await run(provider, 'listTtsModels', () => client.listTtsModels());
  const model = env.SONIOX_TTS_MODEL_ID;
  if (!model) return skipped(provider, 'listSharedVoices/previewTts', 'missing SONIOX_TTS_MODEL_ID');
  await run(provider, 'listSharedVoices', () => client.listSharedVoices(model));
  if (!mutationsAllowed(provider)) return skipped(provider, 'previewTts', 'set LIVE_SMOKE_ALLOW_MUTATIONS=1 with LIVE_SMOKE_SONIOX_VOICE; TTS consumes paid quota');
  const voice = env.LIVE_SMOKE_SONIOX_VOICE;
  if (!voice) return skipped(provider, 'previewTts', 'missing LIVE_SMOKE_SONIOX_VOICE');
  await run(provider, 'previewTts', () => client.previewTts({
    model, language: 'en', voice, audio_format: 'pcm_s16le', text: 'Integration smoke test', sample_rate: 16000,
  }));
}

async function main(): Promise<void> {
  if (getIntegrationsMode(env) !== 'live') throw new Error('Set INTEGRATIONS_MODE=live to run live provider smoke tests');
  for (const smoke of [smokeTelnyx, smokeStripe, smokeResend, smokeFirecrawl, smokeGemini, smokeSoniox]) {
    try {
      await smoke();
    } catch (error) {
      process.exitCode = 1;
      line(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

await main();
