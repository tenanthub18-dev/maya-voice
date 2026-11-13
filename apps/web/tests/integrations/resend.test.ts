import {createHmac} from "node:crypto";
import {describe, expect, it, vi} from "vitest";

import {ApiError} from "@/lib/integrations/http";
import {createResendClient, verifyResendWebhook} from "@/lib/integrations/resend";

describe("ResendClient", () => {
  it("sends email with an idempotency key and validates the response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }),
    );
    const client = createResendClient({apiKey: "re_test", baseUrl: "https://resend.test", fetch: fetchImpl});

    await expect(
      client.sendEmail(
        {
          from: "Acme <onboarding@example.com>",
          to: ["owner@example.com"],
          subject: "Hello",
          text: "Hello",
        },
        {idempotencyKey: "email-key"},
      ),
    ).resolves.toEqual({id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794"});

    const [, init] = fetchImpl.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("email-key");
    expect(init?.method).toBe("POST");
  });

  it("fails loudly on a malformed success payload", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({id: 7}), {
        status: 200,
        headers: {"content-type": "application/json"},
      }),
    );
    const client = createResendClient({apiKey: "re_test", baseUrl: "https://resend.test", fetch: fetchImpl});
    await expect(
      client.sendEmail(
        {from: "a@example.com", to: ["b@example.com"], subject: "Hi", text: "Hi"},
        {idempotencyKey: "email-key"},
      ),
    ).rejects.toThrow(/id/i);
  });

  it("preserves Resend's currently unverified provider error shape", async () => {
    const body = {
      statusCode: 429,
      name: "rate_limit_exceeded",
      message: "Too many requests.",
    };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify(body), {
        status: 429,
        headers: {"content-type": "application/json"},
      }),
    );
    const client = createResendClient({apiKey: "re_test", baseUrl: "https://resend.test", fetch: fetchImpl});
    const error = await client
      .sendEmail(
        {from: "a@example.com", to: ["b@example.com"], subject: "Hi", text: "Hi"},
        {idempotencyKey: "email-key"},
      )
      .catch((value) => value);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({provider: "resend", status: 429, body});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
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
    const client = createResendClient({
      apiKey: "re_test",
      baseUrl: "https://resend.test",
      fetch: fetchImpl,
      timeoutMs: 5,
    });

    await expect(
      client.sendEmail(
        {from: "a@example.com", to: "b@example.com", subject: "Hi", text: "Hi"},
        {idempotencyKey: "email-key"},
      ),
    ).rejects.toMatchObject({name: "TimeoutError"});
  });
});

describe("verifyResendWebhook", () => {
  it("verifies Svix v1 signatures using raw bytes and rejects stale deliveries", () => {
    const secretBytes = Buffer.from("test webhook secret");
    const secret = `whsec_${secretBytes.toString("base64")}`;
    const id = "msg_test";
    const timestamp = 1_800_000_000;
    const rawBody = '{"type":"email.delivered"}';
    const signature = createHmac("sha256", secretBytes)
      .update(`${id}.${timestamp}.${rawBody}`)
      .digest("base64");

    expect(
      verifyResendWebhook({
        rawBody,
        svixId: id,
        svixTimestamp: String(timestamp),
        svixSignature: `v1,${signature}`,
        secret,
        nowSeconds: timestamp + 1,
      }),
    ).toBe(true);
    expect(
      verifyResendWebhook({
        rawBody: `${rawBody} `,
        svixId: id,
        svixTimestamp: String(timestamp),
        svixSignature: `v1,${signature}`,
        secret,
        nowSeconds: timestamp + 1,
      }),
    ).toBe(false);
    expect(
      verifyResendWebhook({
        rawBody,
        svixId: id,
        svixTimestamp: String(timestamp),
        svixSignature: `v1,${signature}`,
        secret,
        nowSeconds: timestamp + 301,
      }),
    ).toBe(false);
  });
});
