import {z} from 'zod';

import type {AuthorizedRequest} from '@/lib/api/auth';
import {parseJsonBody} from '@/lib/api/request';

const requestSchema = z.object({
  language: z.enum(['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar']),
  text: z.string().trim().min(1).max(500),
}).strict();

interface VoicePreviewGateway {
  listTtsModels(): Promise<{models: Array<{id: string}>}>;
  previewTts(input: {
    model: string; language: string; voice: string; audio_format: string;
    sample_rate: number; text: string;
  }): Promise<{audio: Uint8Array; contentType: string}>;
}

export function createVoicePreviewHandler(deps: {
  authorize(): Promise<AuthorizedRequest>;
  soniox: VoicePreviewGateway;
  model: string;
  voice: string;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const authorized = await deps.authorize();
      if (!authorized.ok) return authorized.response;
      if (request.method === 'GET') {
        const result = await deps.soniox.listTtsModels();
        return Response.json({reachable: result.models.some((model) => model.id === deps.model)});
      }
      if (request.method !== 'POST') return new Response(null, {status: 405});
      const parsed = await parseJsonBody(request, requestSchema);
      if (!parsed.ok) return parsed.response;
      const preview = await deps.soniox.previewTts({
        model: deps.model,
        language: parsed.data.language === 'fr-CA' ? 'fr' : parsed.data.language === 'en-IN' ? 'en' : parsed.data.language,
        voice: deps.voice,
        audio_format: 'wav',
        sample_rate: 24_000,
        text: parsed.data.text,
      });
      const bytes = new Uint8Array(preview.audio);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
        headers: {'content-type': preview.contentType, 'cache-control': 'private, max-age=300'},
      });
    } catch {
      return Response.json({error: {code: 'PROVIDER_ERROR', message: 'Voice preview is unavailable'}}, {status: 502});
    }
  };
}
