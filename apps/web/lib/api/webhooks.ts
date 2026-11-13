import {z} from 'zod';

import {verifyResendWebhook} from '@/lib/integrations/resend';
import {verifyStripeWebhook} from '@/lib/integrations/stripe';
import {verifyTelnyxWebhook} from '@/lib/integrations/telnyx';

import {apiError, internalApiError} from './errors';
import {rateLimitedResponse, type RateLimitDecision} from './rate-limit';
import {readBodyLimited, requestIp} from './request';
import type {OrderedMutationResult} from './repository';

type Provider = 'stripe' | 'telnyx-sms' | 'resend';

export interface WebhookRepository {
  claimEvent(provider: Provider, eventId: string): Promise<boolean>;
  completeEvent(provider: Provider, eventId: string): Promise<void>;
  failEvent(provider: Provider, eventId: string, errorMessage: string): Promise<void>;
  updateOrganizationBilling(stripeCustomerId: string | null, value: Record<string, unknown>, restaurantId?: string): Promise<OrderedMutationResult>;
  markPaymentPaid(accountId: string, kind: 'order' | 'booking', targetId: string): Promise<OrderedMutationResult>;
  addSmsOptOut(restaurantId: string, phoneE164: string): Promise<void>;
  removeSmsOptOut(restaurantId: string, phoneE164: string): Promise<void>;
  findRestaurantIdByPhoneNumber(e164: string): Promise<string | null>;
  updateSmsDelivery(
    providerMessageId: string,
    status: 'sent' | 'delivered' | 'failed',
    eventAt?: string,
    deliveryError?: unknown,
  ): Promise<OrderedMutationResult>;
}

interface Limiter {consume(key: string): RateLimitDecision | Promise<RateLimitDecision>}
interface CommonDependencies {repository: WebhookRepository; limiter: Limiter; nowSeconds?: () => number}

const stripeEventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  created: z.number().int().nonnegative(),
  account: z.string().min(1).optional(),
  data: z.object({object: z.record(z.string(), z.unknown())}).passthrough(),
}).passthrough();

function stripePaymentMutation(event: z.infer<typeof stripeEventSchema>):
  {accountId: string; kind: 'order' | 'booking'; targetId: string} | undefined {
  if (!event.account || (event.type !== 'checkout.session.completed' && event.type !== 'payment_intent.succeeded')) {
    return undefined;
  }
  const object = event.data.object;
  if (event.type === 'checkout.session.completed' && object.payment_status !== 'paid') return undefined;
  const metadata = objectValue(object.metadata);
  const orderId = requiredString(metadata?.order_id);
  const bookingId = requiredString(metadata?.booking_id);
  if (Boolean(orderId) === Boolean(bookingId)) return undefined;
  return orderId
    ? {accountId: event.account, kind: 'order', targetId: orderId}
    : {accountId: event.account, kind: 'booking', targetId: bookingId!};
}

// VERIFY: Telnyx publishes partial webhook examples for STOP and failed delivery.
// Require the replay key from the documented full event envelope while retaining
// unknown payload fields. https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
const telnyxEventSchema = z.object({
  data: z.object({
    id: z.string().min(1),
    event_type: z.string().min(1),
    occurred_at: z.string().optional(),
    payload: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).passthrough();

// VERIFY: Resend fixtures are composed from its field documentation, so this
// validates stable routing fields and remains permissive about event data.
// https://resend.com/docs/webhooks/event-types
const resendEventSchema = z.object({
  type: z.string().min(1),
  created_at: z.string(),
  data: z.record(z.string(), z.unknown()),
}).passthrough();

async function limited(request: Request, limiter: Limiter): Promise<Response | undefined> {
  const decision = await limiter.consume(`ip:${requestIp(request)}`);
  return decision.allowed ? undefined : rateLimitedResponse(decision.retryAfterSeconds);
}

function invalidSignature(): Response {
  return apiError('INVALID_SIGNATURE', 'Webhook signature is invalid', 400);
}

function invalidEvent(): Response {
  return apiError('INVALID_EVENT', 'Webhook event is invalid', 400);
}

function parseRawJson(rawBody: string): unknown | undefined {
  try { return JSON.parse(rawBody) as unknown; } catch { return undefined; }
}

async function finishEvent(
  repository: WebhookRepository,
  provider: Provider,
  eventId: string,
  operation: () => Promise<void>,
): Promise<Response> {
  if (!await repository.claimEvent(provider, eventId)) {
    return Response.json({received: true, duplicate: true});
  }
  try {
    await operation();
    await repository.completeEvent(provider, eventId);
    return Response.json({received: true});
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook processing failed';
    try { await repository.failEvent(provider, eventId, message); } catch { /* retain original failure */ }
    return internalApiError();
  }
}

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stripeMutation(event: z.infer<typeof stripeEventSchema>):
  {customer: string | null; restaurantId?: string; value: Record<string, unknown>} | undefined {
  const object = event.data.object;
  const customer = requiredString(object.customer);
  const occurredAt = new Date(event.created * 1_000).toISOString();
  switch (event.type) {
    case 'checkout.session.completed': {
      if (!customer) return undefined;
      const subscription = requiredString(object.subscription);
      const metadata = objectValue(object.metadata);
      const restaurantId = requiredString(metadata?.restaurant_id)
        ?? requiredString(object.client_reference_id);
      if (!restaurantId) return undefined;
      return {customer, value: {
        stripe_customer_id: customer,
        ...(subscription ? {stripe_subscription_id: subscription} : {}),
        stripe_checkout_event_created_at: occurredAt,
        stripe_checkout_event_id: event.id,
      }, restaurantId};
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const subscription = requiredString(object.id);
      const status = requiredString(object.status);
      if (!customer || !subscription || !status) return undefined;
      return {customer, value: {
        stripe_subscription_id: subscription,
        stripe_subscription_status: status,
        stripe_subscription_event_created_at: occurredAt,
        stripe_subscription_event_id: event.id,
      }};
    }
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const invoice = requiredString(object.id);
      if (!customer || !invoice) return undefined;
      return {customer, value: {
        last_invoice_id: invoice,
        last_invoice_status: event.type === 'invoice.paid' ? 'paid' : 'payment_failed',
        stripe_invoice_event_created_at: occurredAt,
        stripe_invoice_event_id: event.id,
      }};
    }
    case 'billing.alert.triggered':
      return customer ? {customer, value: {
        stripe_billing_alert_event_created_at: occurredAt,
        stripe_billing_alert_event_id: event.id,
      }} : undefined;
    default:
      return undefined;
  }
}

export function createStripeWebhookHandler(
  dependencies: CommonDependencies & {secret: string},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rateLimit = await limited(request, dependencies.limiter);
    if (rateLimit) return rateLimit;
    const limitedBody = await readBodyLimited(request, 1_024 * 1_024);
    if (!limitedBody.ok) return limitedBody.response;
    const rawBody = new TextDecoder().decode(limitedBody.bytes);
    const signature = request.headers.get('stripe-signature');
    // Stripe signs the exact raw body and recommends a five-minute tolerance.
    // https://docs.stripe.com/webhooks/signature
    if (!signature || !verifyStripeWebhook({
      rawBody, signatureHeader: signature, secret: dependencies.secret,
      toleranceSeconds: 300, nowSeconds: dependencies.nowSeconds?.(),
    })) return invalidSignature();
    const parsed = stripeEventSchema.safeParse(parseRawJson(rawBody));
    if (!parsed.success) return invalidEvent();
    const paymentMutation = stripePaymentMutation(parsed.data);
    const connectedPaymentEvent = Boolean(parsed.data.account)
      && (parsed.data.type === 'checkout.session.completed' || parsed.data.type === 'payment_intent.succeeded');
    const mutation = connectedPaymentEvent ? undefined : stripeMutation(parsed.data);
    const handled = new Set([
      'checkout.session.completed', 'customer.subscription.created',
      'customer.subscription.updated', 'customer.subscription.deleted',
      'invoice.paid', 'invoice.payment_failed', 'billing.alert.triggered',
    ]).has(parsed.data.type);
    // VERIFY: the fixture corpus has no billing.alert.triggered payload. A valid,
    // signed alert without a resolvable customer is acknowledged and deduplicated
    // without mutating billing state until a live payload is captured.
    // https://docs.stripe.com/billing/subscriptions/usage-based/alerts
    if (!connectedPaymentEvent && handled && !mutation && parsed.data.type !== 'billing.alert.triggered') {
      return invalidEvent();
    }
    return finishEvent(dependencies.repository, 'stripe', parsed.data.id, async () => {
      if (paymentMutation) {
        await dependencies.repository.markPaymentPaid(
          paymentMutation.accountId, paymentMutation.kind, paymentMutation.targetId,
        );
      } else if (mutation) {
        const result = await dependencies.repository.updateOrganizationBilling(
          mutation.customer, mutation.value, mutation.restaurantId,
        );
        if (result === 'not_found') throw new Error('Stripe organization mapping was not found');
      }
    });
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function firstPhone(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return requiredString(objectValue(value[0])?.phone_number);
}

function normalizeOptOutKeyword(value: string): string {
  return value.trim().toLocaleUpperCase('fr-CA').normalize('NFD').replace(/\p{M}/gu, '');
}

// Telnyx automatically blocks its documented English stop keywords at the
// messaging-profile level; French equivalents are normalized and recorded by us.
// https://support.telnyx.com/en/articles/1270091-sms-opt-out-keywords-and-stop-words
const OPT_OUT_KEYWORDS = new Set([
  'STOP', 'STOPALL', 'STOP ALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT',
  'ARRET', 'ARRÊT', 'DESABONNER', 'DÉSABONNER',
].map(normalizeOptOutKeyword));
const OPT_IN_KEYWORDS = new Set(['START', 'UNSTOP'].map(normalizeOptOutKeyword));

async function processTelnyxEvent(
  repository: WebhookRepository,
  event: z.infer<typeof telnyxEventSchema>,
): Promise<void> {
  const {event_type: eventType, occurred_at: occurredAt, payload} = event.data;
  if (eventType === 'message.received') {
    const textValue = requiredString(payload.text);
    const text = textValue ? normalizeOptOutKeyword(textValue) : undefined;
    if (!text || (!OPT_OUT_KEYWORDS.has(text) && !OPT_IN_KEYWORDS.has(text))) return;
    const from = requiredString(objectValue(payload.from)?.phone_number);
    const to = firstPhone(payload.to);
    if (!from || !to) throw new Error('Telnyx opt-out payload is incomplete');
    const restaurantId = await repository.findRestaurantIdByPhoneNumber(to);
    if (restaurantId) {
      if (OPT_OUT_KEYWORDS.has(text)) await repository.addSmsOptOut(restaurantId, from);
      else await repository.removeSmsOptOut(restaurantId, from);
    }
    return;
  }
  if (eventType !== 'message.sent' && eventType !== 'message.finalized') return;
  const messageId = requiredString(payload.id);
  if (!messageId) throw new Error('Telnyx delivery payload has no message id');
  const errors = Array.isArray(payload.errors) ? payload.errors : [];
  const destinationStatus = requiredString(objectValue(Array.isArray(payload.to) ? payload.to[0] : undefined)?.status);
  const failed = errors.length > 0 || destinationStatus === 'delivery_failed' || destinationStatus === 'failed';
  const status = eventType === 'message.sent' ? 'sent' : failed ? 'failed' : 'delivered';
  const result = await repository.updateSmsDelivery(
    messageId,
    status,
    occurredAt,
    failed ? errors : undefined,
  );
  if (result === 'not_found') throw new Error('SMS log entry was not found');
}

export function createTelnyxSmsWebhookHandler(
  dependencies: CommonDependencies & {publicKey: string},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rateLimit = await limited(request, dependencies.limiter);
    if (rateLimit) return rateLimit;
    const rawBody = await request.text();
    const signature = request.headers.get('telnyx-signature-ed25519');
    const timestamp = request.headers.get('telnyx-timestamp');
    if (!signature || !timestamp || !verifyTelnyxWebhook({
      rawBody, signature, timestamp, publicKey: dependencies.publicKey,
      toleranceSeconds: 300, nowSeconds: dependencies.nowSeconds?.(),
    })) return invalidSignature();
    const parsed = telnyxEventSchema.safeParse(parseRawJson(rawBody));
    if (!parsed.success) return invalidEvent();
    return finishEvent(dependencies.repository, 'telnyx-sms', parsed.data.data.id, () =>
      processTelnyxEvent(dependencies.repository, parsed.data));
  };
}

export function createResendWebhookHandler(
  dependencies: CommonDependencies & {secret: string},
): (request: Request) => Promise<Response> {
  return async (request) => {
    const rateLimit = await limited(request, dependencies.limiter);
    if (rateLimit) return rateLimit;
    const rawBody = await request.text();
    const id = request.headers.get('svix-id');
    const timestamp = request.headers.get('svix-timestamp');
    const signature = request.headers.get('svix-signature');
    if (!id || !timestamp || !signature || !verifyResendWebhook({
      rawBody, svixId: id, svixTimestamp: timestamp, svixSignature: signature,
      secret: dependencies.secret, toleranceSeconds: 300, nowSeconds: dependencies.nowSeconds?.(),
    })) return invalidSignature();
    const parsed = resendEventSchema.safeParse(parseRawJson(rawBody));
    if (!parsed.success) return invalidEvent();
    return finishEvent(dependencies.repository, 'resend', id, async () => {});
  };
}
