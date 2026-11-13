import {generateKeyPairSync, sign} from "node:crypto";
import {readFileSync} from "node:fs";
import {describe, expect, it, vi} from "vitest";

import {ApiError} from "@/lib/integrations/http";
import {createTelnyxClient, verifyTelnyxWebhook} from "@/lib/integrations/telnyx";

function fixture(name: string): unknown {
  const value = JSON.parse(
    readFileSync(
      new URL(`../../../../docs/api/telnyx/fixtures/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as {body: unknown};
  return value.body;
}

function jsonFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: {"content-type": "application/json"},
    }),
  );
}

describe("TelnyxClient", () => {
  it("uses the documented endpoints and validates every supported response", async () => {
    const responses = [
      fixture("search-numbers.response"),
      fixture("number-order-create.response"),
      fixture("numbers-list.response"),
      fixture("number-delete.response"),
      fixture("number-assign-connection.response"),
      fixture("messages-send.response"),
    ];
    const fetchImpl = vi.fn<typeof fetch>();
    for (const body of responses) {
      fetchImpl.mockResolvedValueOnce(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: {"content-type": "application/json"},
        }),
      );
    }
    const client = createTelnyxClient({
      apiKey: "test-key",
      baseUrl: "https://telnyx.test/v2",
      fetch: fetchImpl,
    });

    await expect(client.searchNumbers({areaCode: "416", limit: 5})).resolves.toMatchObject({
      data: [{phone_number: "+19705555098"}],
    });
    await expect(
      client.orderNumber({phoneNumber: "+14165550123", customerReference: "rest_123"}),
    ).resolves.toMatchObject({data: {record_type: "number_order"}});
    await expect(client.listNumbers({pageSize: 25})).resolves.toMatchObject({
      data: [{status: "active"}],
    });
    await expect(client.releaseNumber("number-id")).resolves.toMatchObject({
      data: {status: "deleted"},
    });
    await expect(client.assignToTeXmlApp("number-id", "connection-id")).resolves.toMatchObject({
      data: {connection_id: "1293384261075731499"},
    });
    await expect(
      client.sendSms(
        {from: "+14165550100", to: "+14165550101", text: "Hello"},
        {idempotencyKey: "message-key"},
      ),
    ).resolves.toMatchObject({data: {record_type: "message"}});

    expect(fetchImpl.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/v2/available_phone_numbers",
      "/v2/number_orders",
      "/v2/phone_numbers",
      "/v2/phone_numbers/number-id",
      "/v2/phone_numbers/number-id",
      "/v2/messages",
    ]);
    const smsHeaders = new Headers(fetchImpl.mock.calls[5]?.[1]?.headers);
    expect(smsHeaders.get("idempotency-key")).toBe("message-key");
  });

  it("preserves Telnyx error details in ApiError", async () => {
    const client = createTelnyxClient({
      apiKey: "test-key",
      baseUrl: "https://telnyx.test/v2",
      fetch: jsonFetch(fixture("error-422"), 422),
    });

    const error = await client.orderNumber({phoneNumber: "invalid"}).catch((value) => value);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({status: 422, provider: "telnyx"});
    expect((error as ApiError).body).toMatchObject({errors: [{code: "10027"}]});
  });

  it("fails loudly when a success response violates the schema", async () => {
    const client = createTelnyxClient({
      apiKey: "test-key",
      baseUrl: "https://telnyx.test/v2",
      fetch: jsonFetch({data: [{phone_number: 4165550100}]}),
    });

    await expect(client.searchNumbers({areaCode: "416"})).rejects.toThrow(/phone_number/i);
  });

  it("surfaces the shared HTTP timeout through the client", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
    );
    const client = createTelnyxClient({
      apiKey: "test-key",
      baseUrl: "https://telnyx.test/v2",
      fetch: fetchImpl,
      timeoutMs: 5,
    });

    await expect(client.searchNumbers({areaCode: "416"})).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("retries a transient failure for a safe search", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({errors: []}, {status: 503}))
      .mockResolvedValueOnce(Response.json(fixture("search-numbers.response")));
    const client = createTelnyxClient({
      apiKey: "test-key",
      baseUrl: "https://telnyx.test/v2",
      fetch: fetchImpl,
    });

    await expect(client.searchNumbers({areaCode: "416"})).resolves.toMatchObject({
      data: expect.any(Array),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("verifyTelnyxWebhook", () => {
  it("verifies exact raw bytes and rejects altered bodies and stale timestamps", () => {
    const {privateKey, publicKey} = generateKeyPairSync("ed25519");
    const rawBody = '{"data":{"id":"event-1"}}';
    const timestamp = 1_800_000_000;
    const signature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString(
      "base64",
    );
    const rawPublicKey = publicKey.export({format: "der", type: "spki"}).subarray(-32).toString("base64");

    expect(
      verifyTelnyxWebhook({
        rawBody,
        signature,
        timestamp: String(timestamp),
        publicKey: rawPublicKey,
        nowSeconds: timestamp + 1,
      }),
    ).toBe(true);
    expect(
      verifyTelnyxWebhook({
        rawBody: `${rawBody} `,
        signature,
        timestamp: String(timestamp),
        publicKey: rawPublicKey,
        nowSeconds: timestamp + 1,
      }),
    ).toBe(false);
    expect(
      verifyTelnyxWebhook({
        rawBody,
        signature,
        timestamp: String(timestamp),
        publicKey: rawPublicKey,
        nowSeconds: timestamp + 301,
      }),
    ).toBe(false);
  });
});
