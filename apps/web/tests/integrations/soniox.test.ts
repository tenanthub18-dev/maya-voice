import {describe, expect, it, vi} from 'vitest';

import {createSonioxClient} from '@/lib/integrations/soniox';
import {ApiError} from '@/lib/integrations/http';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
}

describe('SonioxClient', () => {
  it('lists models and voices using the documented REST endpoints', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({models: [{id: 'stt-rt-v5', name: 'Realtime'}]}))
      .mockResolvedValueOnce(jsonResponse({models: [{id: 'tts-rt-v2', name: 'TTS', languages: [], voices: []}]}))
      .mockResolvedValueOnce(jsonResponse({voices: [{id: 'voice-1', name: 'Voice'}]}));
    const client = createSonioxClient({baseUrl: 'https://api.soniox.com', apiKey: 'test', ttsPath: '/tts', fetch});

    await expect(client.listModels()).resolves.toMatchObject({models: [{id: 'stt-rt-v5'}]});
    await expect(client.listTtsModels()).resolves.toMatchObject({models: [{id: 'tts-rt-v2'}]});
    await expect(client.listSharedVoices('tts-rt-v2')).resolves.toMatchObject({voices: [{id: 'voice-1'}]});
    expect((fetch.mock.calls as unknown[][]).map(([input]) => new URL(String(input)).pathname)).toEqual(['/v1/models', '/v1/tts-models', '/v1/shared-voices']);
  });

  it('returns raw TTS preview audio and sends the model explicitly', async () => {
    const audio = Uint8Array.from([1, 2, 3, 4]);
    const fetch = vi.fn(async () => new Response(audio, {status: 200, headers: {'content-type': 'audio/wav'}}));
    const client = createSonioxClient({baseUrl: 'https://api.soniox.com', apiKey: 'test', ttsPath: '/tts', fetch});

    const result = await client.previewTts({model: 'tts-rt-v2', language: 'ur', voice: 'voice-1', audio_format: 'wav', text: 'سلام'});
    expect([...new Uint8Array(result.audio)]).toEqual([1, 2, 3, 4]);
    expect(result.contentType).toBe('audio/wav');
    const request = (fetch.mock.calls as unknown[][])[0] as [unknown, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({model: 'tts-rt-v2'});
  });

  it('posts TTS to an absolute ttsPath host instead of the REST base URL', async () => {
    const fetch = vi.fn(async () => new Response(Uint8Array.from([1]), {status: 200}));
    const client = createSonioxClient({baseUrl: 'https://api.soniox.com', apiKey: 'test', ttsPath: 'https://tts-rt.soniox.com/tts', fetch});

    await client.previewTts({model: 'tts-rt-v2', language: 'en', voice: 'Daniel', audio_format: 'wav', text: 'Hi'});
    expect(String((fetch.mock.calls as unknown[][])[0]![0])).toBe('https://tts-rt.soniox.com/tts');
  });

  it('fails loudly on a model-list schema mismatch', async () => {
    const client = createSonioxClient({baseUrl: 'https://mock.test', apiKey: 'test', ttsPath: '/tts', fetch: async () => jsonResponse({models: 'bad'})});
    await expect(client.listModels()).rejects.toThrow(/invalid input/i);
  });

  it('preserves provider errors, retries transient GETs, and times out', async () => {
    const errorClient = createSonioxClient({baseUrl: 'https://mock.test', apiKey: 'test', ttsPath: '/tts', fetch: async () => new Response(JSON.stringify({error_code: 401, error_type: 'unauthenticated', error_message: 'bad key'}), {status: 401})});
    const error = await errorClient.listModels().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({status: 401, body: {error_type: 'unauthenticated'}});

    let attempts = 0;
    const retryClient = createSonioxClient({
      baseUrl: 'https://mock.test', apiKey: 'test', ttsPath: '/tts',
      fetch: async () => (++attempts === 1 ? new Response('{"error":"busy"}', {status: 503}) : jsonResponse({models: []})),
      request: {sleep: async () => {}, random: () => 0},
    });
    await expect(retryClient.listModels()).resolves.toEqual({models: []});
    expect(attempts).toBe(2);

    const timeoutClient = createSonioxClient({
      baseUrl: 'https://mock.test', apiKey: 'test', ttsPath: '/tts', request: {timeoutMs: 1},
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    });
    await expect(timeoutClient.listModels()).rejects.toMatchObject({name: 'TimeoutError'});
  });
});
