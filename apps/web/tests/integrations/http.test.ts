import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ApiError, requestBinary, requestJson } from "@/lib/integrations/http";

describe("requestJson", () => {
  it("validates and returns a successful JSON response", async () => {
    const fetchFn = vi.fn(async () => Response.json({ id: "ok" }));

    await expect(
      requestJson({
        provider: "test",
        url: "https://provider.example/items",
        schema: z.object({ id: z.string() }),
        fetchFn,
      }),
    ).resolves.toEqual({ id: "ok" });
  });

  it("fails loudly when a successful response violates its schema", async () => {
    await expect(
      requestJson({
        provider: "test",
        url: "https://provider.example/items",
        schema: z.object({ id: z.string() }),
        fetchFn: async () => Response.json({ id: 42 }),
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
  });

  it("throws a typed ApiError with the parsed provider body", async () => {
    const promise = requestJson({
      provider: "test",
      url: "https://provider.example/items",
      schema: z.object({ id: z.string() }),
      retries: 0,
      fetchFn: async () =>
        Response.json({ errors: [{ detail: "bad input" }] }, { status: 422 }),
    });

    await expect(promise).rejects.toBeInstanceOf(ApiError);
    await expect(promise).rejects.toMatchObject({
      provider: "test",
      status: 422,
      body: { errors: [{ detail: "bad input" }] },
    });
  });

  it("retries a safe request and honors Retry-After seconds", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({}, { status: 429, headers: { "Retry-After": "2" } }),
      )
      .mockResolvedValueOnce(Response.json({ id: "ok" }));
    const sleep = vi.fn(async () => undefined);

    await requestJson({
      provider: "test",
      url: "https://provider.example/items",
      schema: z.object({ id: z.string() }),
      fetchFn,
      sleep,
      random: () => 0.5,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("honors an HTTP-date Retry-After value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({}, {
          status: 503,
          headers: { "Retry-After": "Tue, 27 Oct 2026 12:00:03 GMT" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ id: "ok" }));
    const sleep = vi.fn(async () => undefined);

    try {
      await requestJson({
        provider: "test",
        url: "https://provider.example/items",
        schema: z.object({ id: z.string() }),
        fetchFn,
        sleep,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("does not retry an unsafe POST without an idempotency key", async () => {
    const fetchFn = vi.fn(async () => Response.json({}, { status: 503 }));

    await expect(
      requestJson({
        provider: "test",
        method: "POST",
        url: "https://provider.example/items",
        schema: z.object({ id: z.string() }),
        fetchFn,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("adds an idempotency key and retries an idempotent POST", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({}, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ id: "ok" }));

    await requestJson({
      provider: "test",
      method: "POST",
      url: "https://provider.example/items",
      schema: z.object({ id: z.string() }),
      idempotencyKey: "attempt-1",
      fetchFn,
      sleep: async () => undefined,
      random: () => 0,
    });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      "attempt-1",
    );
  });

  it("aborts a request after its timeout", async () => {
    const fetchFn = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      }),
    );

    await expect(
      requestJson({
        provider: "test",
        url: "https://provider.example/items",
        schema: z.object({ id: z.string() }),
        timeoutMs: 5,
        retries: 0,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("keeps the timeout active while the response body is being read", async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      requestJson({
        provider: "test",
        url: "https://provider.example/items",
        schema: z.object({ id: z.string() }),
        timeoutMs: 5,
        retries: 0,
        fetchFn,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});

describe("requestBinary", () => {
  it("validates and returns successful binary response bytes", async () => {
    await expect(
      requestBinary({
        provider: "test",
        url: "https://provider.example/audio",
        schema: z.instanceof(Uint8Array),
        fetchFn: async () => new Response(new Uint8Array([1, 2, 3])),
      }),
    ).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });
});
