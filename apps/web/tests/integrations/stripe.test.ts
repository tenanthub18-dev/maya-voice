import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";

import {ApiError} from "@/lib/integrations/http";
import {createStripeClient, verifyStripeWebhook} from "@/lib/integrations/stripe";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../../../docs/api/stripe/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

describe("StripeClient", () => {
  it("form-encodes mutations, sends idempotency keys, and validates all supported responses", async () => {
    const bodies = [
      fixture("customers.create.response"),
      fixture("checkout.sessions.create.response.subscription_mode.derived"),
      fixture("billing_portal.sessions.create.response"),
      fixture("invoices.list.response"),
      fixture("billing.meter_events.create.response"),
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const body of bodies) {
      fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {"content-type": "application/json"},
        }),
      );
    }
    const client = createStripeClient({
      apiKey: "sk_test_only",
      baseUrl: "https://stripe.test",
      fetch: fetchImpl,
    });

    await expect(
      client.createCustomer(
        {name: "Restaurant", email: "owner@example.com", restaurantId: "rest_123"},
        {idempotencyKey: "customer-key"},
      ),
    ).resolves.toMatchObject({object: "customer"});
    await expect(
      client.createCheckoutSession(
        {
          customerId: "cus_123",
          basePriceId: "price_base",
          meteredPriceId: "price_metered",
          successUrl: "https://app.test/success",
          cancelUrl: "https://app.test/cancel",
          restaurantId: "rest_123",
        },
        {idempotencyKey: "checkout-key"},
      ),
    ).resolves.toMatchObject({object: "checkout.session", mode: "subscription"});
    await expect(
      client.createPortalSession(
        {customerId: "cus_123", returnUrl: "https://app.test/account"},
        {idempotencyKey: "portal-key"},
      ),
    ).resolves.toMatchObject({object: "billing_portal.session"});
    await expect(client.listInvoices({customerId: "cus_123", limit: 10})).resolves.toMatchObject({
      object: "list",
    });
    await expect(
      client.createMeterEvent(
        {
          eventName: "call_minutes",
          customerId: "cus_123",
          value: "1.5",
          identifier: "call_123:final",
        },
        {idempotencyKey: "meter-key"},
      ),
    ).resolves.toMatchObject({object: "billing.meter_event"});

    const customerRequest = fetchImpl.mock.calls[0]?.[1];
    expect(new Headers(customerRequest?.headers).get("content-type")).toContain(
      "application/x-www-form-urlencoded",
    );
    expect(new Headers(customerRequest?.headers).get("idempotency-key")).toBe("customer-key");
    expect(String(customerRequest?.body)).toContain("metadata%5Brestaurant_id%5D=rest_123");
    const checkoutBody = new URLSearchParams(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(checkoutBody.get("automatic_tax[enabled]")).toBe("true");
    expect(checkoutBody.get("customer_update[address]")).toBe("auto");
    expect(checkoutBody.get("billing_address_collection")).toBe("required");
    expect(new URL(String(fetchImpl.mock.calls[3]?.[0])).searchParams.get("customer")).toBe(
      "cus_123",
    );
  });

  it("fails loudly on an invalid success payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({object: "customer", id: 42}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }),
    );
    const client = createStripeClient({apiKey: "key", baseUrl: "https://stripe.test", fetch: fetchImpl});
    await expect(
      client.createCustomer({name: "Restaurant"}, {idempotencyKey: "key"}),
    ).rejects.toThrow(/id/i);
  });

  it("preserves Stripe's provider error shape", async () => {
    const errors = fixture("errors.shape") as {
      example_invalid_request: unknown;
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(errors.example_invalid_request), {
        status: 404,
        headers: {"content-type": "application/json"},
      }),
    );
    const client = createStripeClient({apiKey: "key", baseUrl: "https://stripe.test", fetch: fetchImpl});

    const error = await client.listInvoices({customerId: "missing"}).catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({provider: "stripe", status: 404});
    expect((error as ApiError).body).toMatchObject({error: {code: "resource_missing"}});
  });

  it("retries an idempotent mutation after a 500", async () => {
    const response = fixture("customers.create.response");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({error: {type: "api_error"}}), {status: 500}))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(response), {
          status: 200,
          headers: {"content-type": "application/json"},
        }),
      );
    const client = createStripeClient({apiKey: "key", baseUrl: "https://stripe.test", fetch: fetchImpl});

    await expect(
      client.createCustomer({name: "Restaurant"}, {idempotencyKey: "retry-key"}),
    ).resolves.toMatchObject({object: "customer"});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces request timeouts", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const client = createStripeClient({
      apiKey: "key",
      baseUrl: "https://stripe.test",
      fetch: fetchImpl,
      timeoutMs: 5,
    });

    await expect(client.listInvoices({customerId: "cus_test"})).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("creates and inspects a Standard connected account through typed contracts", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture("accounts.create.standard.response")), {status: 200}))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture("account_links.create.response")), {status: 200}))
      .mockResolvedValueOnce(new Response(JSON.stringify(fixture("accounts.create.standard.response")), {status: 200}));
    const client = createStripeClient({apiKey: "key", baseUrl: "https://stripe.test", fetch: fetchImpl});

    await expect(client.createStandardAccount({restaurantId: "rest_123"}, {idempotencyKey: "connect:rest_123"}))
      .resolves.toMatchObject({id: "acct_123", type: "standard", charges_enabled: false});
    await expect(client.createAccountOnboardingLink({
      accountId: "acct_123",
      refreshUrl: "https://app.test/settings?connect=refresh",
      returnUrl: "https://app.test/settings?connect=return",
    }, {idempotencyKey: "connect-link:rest_123"})).resolves.toMatchObject({object: "account_link"});
    await expect(client.retrieveAccount({accountId: "acct_123"}))
      .resolves.toMatchObject({details_submitted: false, payouts_enabled: false});

    expect(new URL(String(fetchImpl.mock.calls[0]?.[0])).pathname).toBe("/v1/accounts");
    expect(new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body)).get("type")).toBe("standard");
    expect(new URLSearchParams(String(fetchImpl.mock.calls[0]?.[1]?.body)).get("metadata[restaurant_id]")).toBe("rest_123");
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).pathname).toBe("/v1/account_links");
    expect(new URLSearchParams(String(fetchImpl.mock.calls[1]?.[1]?.body)).get("type")).toBe("account_onboarding");
    expect(fetchImpl.mock.calls[2]?.[1]?.method).toBe("GET");
  });

  it("creates a one-time CAD Payment Link scoped to the connected account", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify(fixture("payment_links.create.response")), {status: 200}),
    );
    const client = createStripeClient({apiKey: "key", baseUrl: "https://stripe.test", fetch: fetchImpl});

    await expect(client.createConnectedPaymentLink({
      connectedAccountId: "acct_123",
      amountCents: 4_275,
      currency: "cad",
      productName: "Order order_123",
      restaurantId: "rest_123",
      target: {kind: "order", id: "order_123"},
    }, {idempotencyKey: "call_123:order_123"})).resolves.toMatchObject({
      id: "plink_123",
      url: "https://buy.stripe.com/test_example",
    });

    const request = fetchImpl.mock.calls[0]?.[1];
    const body = new URLSearchParams(String(request?.body));
    expect(new Headers(request?.headers).get("stripe-account")).toBe("acct_123");
    expect(new Headers(request?.headers).get("idempotency-key")).toBe("call_123:order_123");
    expect(body.get("line_items[0][price_data][currency]")).toBe("cad");
    expect(body.get("line_items[0][price_data][unit_amount]")).toBe("4275");
    expect(body.get("line_items[0][price_data][product_data][name]")).toBe("Order order_123");
    expect(body.get("line_items[0][quantity]")).toBe("1");
    expect(body.get("restrictions[completed_sessions][limit]")).toBe("1");
    expect(body.get("metadata[restaurant_id]")).toBe("rest_123");
    expect(body.get("metadata[order_id]")).toBe("order_123");
    expect(body.get("payment_intent_data[metadata][order_id]")).toBe("order_123");
    expect(body.has("metadata[booking_id]")).toBe(false);
  });
});

describe("verifyStripeWebhook", () => {
  it("matches the documented fixture vector and enforces timestamp tolerance", () => {
    const vector = fixture("webhook.signature.test_vector") as {
      raw_body: string;
      secret: string;
      stripe_signature_header: string;
      timestamp: number;
    };
    expect(
      verifyStripeWebhook({
        rawBody: vector.raw_body,
        signatureHeader: vector.stripe_signature_header,
        secret: vector.secret,
        nowSeconds: vector.timestamp,
      }),
    ).toBe(true);
    expect(
      verifyStripeWebhook({
        rawBody: `${vector.raw_body} `,
        signatureHeader: vector.stripe_signature_header,
        secret: vector.secret,
        nowSeconds: vector.timestamp,
      }),
    ).toBe(false);
    expect(
      verifyStripeWebhook({
        rawBody: vector.raw_body,
        signatureHeader: vector.stripe_signature_header,
        secret: vector.secret,
        nowSeconds: vector.timestamp + 301,
      }),
    ).toBe(false);
  });
});
