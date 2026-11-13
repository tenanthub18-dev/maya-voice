import {describe, expect, it, vi} from 'vitest';

import {createGeminiClient} from '@/lib/integrations/gemini';
import {ApiError} from '@/lib/integrations/http';

describe('GeminiClient', () => {
  it('requests structured output without deprecated sampling fields', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{content: {role: 'model', parts: [{text: '{"name":"Cafe"}'}]}, finishReason: 'STOP', index: 0}],
      usageMetadata: {promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5},
      modelVersion: 'configured-model', responseId: 'response-1',
    }), {status: 200, headers: {'content-type': 'application/json'}}));
    const client = createGeminiClient({baseUrl: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'test', model: 'configured-model', fetch});

    const result = await client.generateStructured({
      prompt: 'Extract the restaurant name',
      schema: {type: 'object', properties: {name: {type: 'string'}}, required: ['name']},
      maxOutputTokens: 300,
    });

    expect(result.json).toEqual({name: 'Cafe'});
    const request = (fetch.mock.calls as unknown[][])[0] as [unknown, RequestInit];
    const body = JSON.parse(String(request[1].body));
    expect(body.generationConfig).toMatchObject({responseMimeType: 'application/json', maxOutputTokens: 300});
    expect(body.generationConfig.responseSchema).toBeDefined();
    expect(body.generationConfig).not.toHaveProperty('temperature');
    expect(body.generationConfig).not.toHaveProperty('topP');
    expect(body.generationConfig).not.toHaveProperty('topK');
    expect(String(request[0])).toContain('/models/configured-model:generateContent');
  });

  it('fails loudly when the provider response or structured JSON is invalid', async () => {
    const make = (body: unknown) => createGeminiClient({
      baseUrl: 'https://mock.test/v1beta', apiKey: 'test', model: 'configured-model',
      fetch: async () => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}}),
    });
    await expect(make({candidates: 'bad'}).generateStructured({prompt: 'x', schema: {type: 'object'}})).rejects.toThrow(/invalid input/i);
    await expect(make({candidates: [{content: {parts: [{text: 'not-json'}]}}]}).generateStructured({prompt: 'x', schema: {type: 'object'}})).rejects.toThrow(/JSON/i);
  });

  it('sends documented inline PDF or image data alongside the extraction prompt', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{content: {parts: [{text: '{}'}]}}],
    }), {status: 200}));
    const client = createGeminiClient({baseUrl: 'https://mock.test/v1beta', apiKey: 'test', model: 'model', fetch});

    await client.generateStructured({
      prompt: 'Extract the menu', schema: {type: 'object'},
      inlineData: {mimeType: 'application/pdf', data: 'JVBERg=='},
    });

    const request = (fetch.mock.calls as unknown[][])[0] as [unknown, RequestInit];
    const body = JSON.parse(String(request[1].body));
    expect(body.contents[0].parts).toEqual([
      {text: 'Extract the menu'},
      {inlineData: {mimeType: 'application/pdf', data: 'JVBERg=='}},
    ]);
  });

  it('preserves provider errors, retries idempotent transient requests, and times out', async () => {
    const input = {prompt: 'x', schema: {type: 'object'}};
    const errorClient = createGeminiClient({baseUrl: 'https://mock.test/v1beta', apiKey: 'test', model: 'model', fetch: async () => new Response(JSON.stringify({error: {code: 403, message: 'denied', status: 'PERMISSION_DENIED'}}), {status: 403})});
    const error = await errorClient.generateStructured(input).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({status: 403, body: {error: {message: 'denied'}}});

    let attempts = 0;
    const retryClient = createGeminiClient({
      baseUrl: 'https://mock.test/v1beta', apiKey: 'test', model: 'model',
      fetch: async () => (++attempts === 1
        ? new Response('{"error":"busy"}', {status: 503})
        : new Response(JSON.stringify({candidates: [{content: {parts: [{text: '{}'}]}}]}), {status: 200})),
      request: {sleep: async () => {}, random: () => 0},
    });
    await expect(retryClient.generateStructured(input)).resolves.toMatchObject({json: {}});
    expect(attempts).toBe(2);

    const timeoutClient = createGeminiClient({
      baseUrl: 'https://mock.test/v1beta', apiKey: 'test', model: 'model', request: {timeoutMs: 1},
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    });
    await expect(timeoutClient.generateStructured(input)).rejects.toMatchObject({name: 'TimeoutError'});
  });
});
