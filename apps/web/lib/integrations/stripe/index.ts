import {createHmac, timingSafeEqual} from "node:crypto";
import {z} from "zod";

import {requestJson} from "../http";

export const stripeCustomerSchema = z
  .object({id: z.string(), object: z.literal("customer"), email: z.string().nullish(), metadata: z.record(z.string(), z.string())})
  .passthrough();

// VERIFY: this project fixture is derived from documented fields, not a captured subscription session.
export const stripeCheckoutSessionSchema = z
  .object({
    id: z.string(),
    object: z.literal("checkout.session"),
    mode: z.literal("subscription"),
    status: z.enum(["open", "complete", "expired"]).nullable(),
    customer: z.string().nullable(),
    subscription: z.string().nullable(),
    url: z.string().nullable(),
  })
  .passthrough();

export const stripePortalSessionSchema = z
  .object({id: z.string(), object: z.literal("billing_portal.session"), customer: z.string(), url: z.string()})
  .passthrough();

export const stripeInvoicesListSchema = z
  .object({
    object: z.literal("list"),
    has_more: z.boolean(),
    url: z.string(),
    data: z.array(
      z
        .object({
          id: z.string(),
          object: z.literal("invoice"),
          customer: z.string().nullable(),
          status: z.enum(["draft", "open", "paid", "uncollectible", "void"]).nullable(),
          amount_due: z.number(),
          currency: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const stripeMeterEventSchema = z
  .object({
    object: z.literal("billing.meter_event"),
    event_name: z.string(),
    identifier: z.string(),
    payload: z.record(z.string(), z.string()),
    timestamp: z.number(),
  })
  .passthrough();

export const stripeConnectedAccountSchema = z
  .object({
    id: z.string(),
    object: z.literal("account"),
    type: z.literal("standard"),
    charges_enabled: z.boolean(),
    details_submitted: z.boolean(),
    payouts_enabled: z.boolean(),
  })
  .passthrough();

export const stripeAccountLinkSchema = z
  .object({
    object: z.literal("account_link"),
    created: z.number().int(),
    expires_at: z.number().int(),
    url: z.string().url(),
  })
  .passthrough();

export const stripePaymentLinkSchema = z
  .object({
    id: z.string(),
    object: z.literal("payment_link"),
    active: z.boolean(),
    currency: z.string(),
    metadata: z.record(z.string(), z.string()),
    url: z.string().url(),
  })
  .passthrough();

type Fetch = typeof fetch;

export interface StripeClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: Fetch;
  timeoutMs?: number;
}

interface MutationOptions {
  idempotencyKey: string;
}

function form(entries: ReadonlyArray<readonly [string, string]>): string {
  const value = new URLSearchParams();
  for (const [key, entry] of entries) value.append(key, entry);
  return value.toString();
}

export function createStripeClient(options: StripeClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const headers = {
    authorization: `Basic ${Buffer.from(`${options.apiKey}:`).toString("base64")}`,
    "content-type": "application/x-www-form-urlencoded",
  };
  const common = {provider: "stripe" as const, timeoutMs: options.timeoutMs, fetchFn: options.fetch};

  function mutate<T>(
    path: string,
    entries: ReadonlyArray<readonly [string, string]>,
    schema: z.ZodType<T>,
    requestOptions: MutationOptions,
    connectedAccountId?: string,
  ) {
    return requestJson({
      ...common,
      url: `${baseUrl}${path}`,
      method: "POST",
      headers: connectedAccountId === undefined
        ? headers
        : {...headers, "stripe-account": connectedAccountId},
      body: form(entries),
      idempotencyKey: requestOptions.idempotencyKey,
      schema,
    });
  }

  return {
    // Standard connected accounts and this onboarding flow are explicitly
    // required by PRD F12. https://docs.stripe.com/connect/standard-accounts
    createStandardAccount(
      input: {restaurantId: string},
      requestOptions: MutationOptions,
    ) {
      return mutate(
        "/v1/accounts",
        [
          ["type", "standard"],
          ["metadata[restaurant_id]", input.restaurantId],
        ],
        stripeConnectedAccountSchema,
        requestOptions,
      );
    },

    // Account Links are single-use redirects for Connect Onboarding.
    // https://docs.stripe.com/api/account_links/create
    createAccountOnboardingLink(
      input: {accountId: string; refreshUrl: string; returnUrl: string},
      requestOptions: MutationOptions,
    ) {
      return mutate(
        "/v1/account_links",
        [
          ["account", input.accountId],
          ["refresh_url", input.refreshUrl],
          ["return_url", input.returnUrl],
          ["type", "account_onboarding"],
        ],
        stripeAccountLinkSchema,
        requestOptions,
      );
    },

    // https://docs.stripe.com/api/accounts/retrieve
    retrieveAccount(input: {accountId: string}) {
      return requestJson({
        ...common,
        url: `${baseUrl}/v1/accounts/${encodeURIComponent(input.accountId)}`,
        headers: {authorization: headers.authorization},
        schema: stripeConnectedAccountSchema,
        retrySafe: true,
      });
    },

    // Direct connected-account API calls use Stripe-Account. Payment Links
    // support inline one-time price_data. https://docs.stripe.com/connect/direct-charges
    // https://docs.stripe.com/connect/authentication
    // https://docs.stripe.com/payments/payment-links
    // https://docs.stripe.com/payment-links/create
    createConnectedPaymentLink(
      input: {
        connectedAccountId: string;
        amountCents: number;
        currency: "cad";
        productName: string;
        restaurantId: string;
        target: {kind: "order" | "booking"; id: string};
      },
      requestOptions: MutationOptions,
    ) {
      const targetKey = `${input.target.kind}_id`;
      return mutate(
        "/v1/payment_links",
        [
          ["line_items[0][price_data][product_data][name]", input.productName],
          ["line_items[0][price_data][currency]", input.currency],
          ["line_items[0][price_data][unit_amount]", String(input.amountCents)],
          ["line_items[0][quantity]", "1"],
          // A target-specific link must not charge the same order/deposit twice.
          // https://docs.stripe.com/api/payment_links/object#payment_link_object-restrictions-completed_sessions-limit
          ["restrictions[completed_sessions][limit]", "1"],
          ["metadata[restaurant_id]", input.restaurantId],
          [`metadata[${targetKey}]`, input.target.id],
          // Payment Link metadata is inherited by generated Checkout Sessions;
          // payment_intent_data.metadata covers payment_intent.succeeded too.
          // https://docs.stripe.com/metadata/use-cases#track-affiliate-links
          ["payment_intent_data[metadata][restaurant_id]", input.restaurantId],
          [`payment_intent_data[metadata][${targetKey}]`, input.target.id],
        ],
        stripePaymentLinkSchema,
        requestOptions,
        input.connectedAccountId,
      );
    },

    // https://docs.stripe.com/api/customers/create
    createCustomer(
      input: {name: string; email?: string; restaurantId?: string},
      requestOptions: MutationOptions,
    ) {
      return mutate(
        "/v1/customers",
        [
          ["name", input.name],
          ...(input.email === undefined ? [] : ([["email", input.email]] as const)),
          ...(input.restaurantId === undefined
            ? []
            : ([["metadata[restaurant_id]", input.restaurantId]] as const)),
        ],
        stripeCustomerSchema,
        requestOptions,
      );
    },

    // https://docs.stripe.com/api/checkout/sessions/create
    createCheckoutSession(
      input: {
        customerId: string;
        basePriceId: string;
        meteredPriceId: string;
        successUrl: string;
        cancelUrl: string;
        restaurantId: string;
      },
      requestOptions: MutationOptions,
    ) {
      return mutate(
        "/v1/checkout/sessions",
        [
          ["mode", "subscription"],
          ["customer", input.customerId],
          ["line_items[0][price]", input.basePriceId],
          ["line_items[0][quantity]", "1"],
          ["line_items[1][price]", input.meteredPriceId],
          ["success_url", input.successUrl],
          ["cancel_url", input.cancelUrl],
          ["client_reference_id", input.restaurantId],
          ["metadata[restaurant_id]", input.restaurantId],
          ["subscription_data[metadata][restaurant_id]", input.restaurantId],
          ["automatic_tax[enabled]", "true"],
          // VERIFY in Stripe test mode: the docs describe these parameters, while
          // this exact automatic-tax/customer-update combination is composed.
          ["customer_update[address]", "auto"],
          ["billing_address_collection", "required"],
        ],
        stripeCheckoutSessionSchema,
        requestOptions,
      );
    },

    // https://docs.stripe.com/api/customer_portal/sessions/create
    createPortalSession(
      input: {customerId: string; returnUrl: string},
      requestOptions: MutationOptions,
    ) {
      return mutate(
        "/v1/billing_portal/sessions",
        [
          ["customer", input.customerId],
          ["return_url", input.returnUrl],
        ],
        stripePortalSessionSchema,
        requestOptions,
      );
    },

    // https://docs.stripe.com/api/invoices/list
    listInvoices(input: {customerId: string; limit?: number}) {
      const url = new URL(`${baseUrl}/v1/invoices`);
      url.searchParams.set("customer", input.customerId);
      url.searchParams.set("limit", String(input.limit ?? 10));
      return requestJson({
        ...common,
        url: url.toString(),
        headers: {authorization: headers.authorization},
        schema: stripeInvoicesListSchema,
        retrySafe: true,
      });
    },

    // https://docs.stripe.com/api/billing/meter-event/create
    createMeterEvent(
      input: {
        eventName: string;
        customerId: string;
        value: string;
        identifier: string;
        timestamp?: number;
      },
      requestOptions: MutationOptions,
    ) {
      return mutate(
        "/v1/billing/meter_events",
        [
          ["event_name", input.eventName],
          ["payload[stripe_customer_id]", input.customerId],
          ["payload[value]", input.value],
          ["identifier", input.identifier],
          ...(input.timestamp === undefined
            ? []
            : ([["timestamp", String(input.timestamp)]] as const)),
        ],
        stripeMeterEventSchema,
        requestOptions,
      );
    },
  };
}

export interface StripeWebhookVerificationInput {
  rawBody: string | Uint8Array;
  signatureHeader: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

function equalHex(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/iu.test(left) || !/^[a-f0-9]+$/iu.test(right)) return false;
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

// https://docs.stripe.com/webhooks#verify-manually
export function verifyStripeWebhook(input: StripeWebhookVerificationInput): boolean {
  const parts = input.signatureHeader.split(",").map((part) => part.trim());
  const timestampText = parts.find((part) => part.startsWith("t="))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith("v1=")).map((part) => part.slice(3));
  const timestamp = Number(timestampText);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > (input.toleranceSeconds ?? 300)) {
    return false;
  }
  const body = typeof input.rawBody === "string" ? input.rawBody : Buffer.from(input.rawBody);
  const payload = Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]);
  const expected = createHmac("sha256", input.secret).update(payload).digest("hex");
  return signatures.some((signature) => equalHex(expected, signature));
}
