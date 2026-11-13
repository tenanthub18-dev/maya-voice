import {describe, expect, it} from 'vitest';

import {createVoicePreviewHandler} from '@/app/api/soniox/preview/_lib';

describe('voice preview route', () => {
  const authorize = async () => ({ok: true as const, user: {
    id: 'user-1', email: 'owner@example.com', role: 'owner' as const, organizationId: 'org-1',
  }});

  it('reports reachability and returns playable TTS bytes', async () => {
    const handler = createVoicePreviewHandler({
      authorize,
      soniox: {
        listTtsModels: async () => ({models: [{id: 'tts-rt-v2'}]}),
        previewTts: async () => ({audio: Uint8Array.from([82, 73, 70, 70]), contentType: 'audio/wav'}),
      },
      model: 'tts-rt-v2', voice: 'Priya',
    });
    const health = await handler(new Request('https://app.example/api/soniox/preview'));
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({reachable: true});

    const preview = await handler(new Request('https://app.example/api/soniox/preview', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({language: 'fr-CA', text: 'Bonjour'}),
    }));
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('audio/wav');
    expect([...new Uint8Array(await preview.arrayBuffer())]).toEqual([82, 73, 70, 70]);
  });

  it('fails gracefully when Soniox throws', async () => {
    const handler = createVoicePreviewHandler({
      authorize,
      soniox: {
        listTtsModels: async () => { throw new Error('offline'); },
        previewTts: async () => { throw new Error('offline'); },
      },
      model: 'tts-rt-v2', voice: 'Priya',
    });
    const response = await handler(new Request('https://app.example/api/soniox/preview'));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({error: {code: 'PROVIDER_ERROR', message: 'Voice preview is unavailable'}});
  });

  it('rejects unauthenticated requests before contacting Soniox', async () => {
    let contacted = false;
    const handler = createVoicePreviewHandler({
      authorize: async () => ({
        ok: false as const,
        response: Response.json({error: {code: 'UNAUTHORIZED', message: 'Authentication required'}}, {status: 401}),
      }),
      soniox: {
        listTtsModels: async () => { contacted = true; return {models: []}; },
        previewTts: async () => { contacted = true; return {audio: new Uint8Array(), contentType: 'audio/wav'}; },
      },
      model: 'tts-rt-v2', voice: 'Priya',
    });

    expect((await handler(new Request('https://app.example/api/soniox/preview'))).status).toBe(401);
    expect(contacted).toBe(false);
  });
});
