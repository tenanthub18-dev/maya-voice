import {z} from 'zod';

import {requestBinary, requestJson} from '../http';

type Fetch = typeof fetch;

const languageSchema = z.object({code: z.string(), name: z.string()}).passthrough();
const voiceSchema = z.object({
  id: z.string(), name: z.string().optional(), description: z.string().optional(),
  gender: z.string().optional(),
}).passthrough();

// VERIFY: schema is documented but fixture values are illustrative, so extra model
// capability fields remain allowed until captured from the live API.
const modelsSchema = z.object({models: z.array(z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(languageSchema).optional(),
}).passthrough())}).passthrough();
const ttsModelsSchema = z.object({models: z.array(z.object({
  id: z.string(), name: z.string().optional(), languages: z.array(languageSchema).optional(),
  voices: z.array(voiceSchema).optional(),
}).passthrough())}).passthrough();
const voicesSchema = z.object({voices: z.array(voiceSchema), next_page_cursor: z.string().nullable().optional()}).passthrough();

export interface SonioxClientOptions {
  baseUrl: string;
  apiKey: string;
  /** VERIFY: docs publish POST /tts but do not confirm a /v1 prefix. */
  ttsPath: string;
  fetch?: Fetch;
  request?: {timeoutMs?: number; retries?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number};
}

export interface TtsPreviewInput {
  model: string;
  language: string;
  voice: string;
  audio_format: string;
  text: string;
  sample_rate?: number;
  speed?: number;
  reduce_silence?: boolean;
}

export function createSonioxClient(options: SonioxClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const auth = {Authorization: `Bearer ${options.apiKey}`};
  const get = <T>(path: string, schema: z.ZodType<T>) => requestJson({
    provider: 'soniox', url: `${baseUrl}${path}`, headers: auth, schema, fetchFn: options.fetch,
    ...options.request,
  });

  return {
    // https://soniox.com/docs/api-reference/stt/get_models.mdx
    listModels: () => get('/v1/models', modelsSchema),
    // https://soniox.com/docs/api-reference/tts/get_tts_models.mdx
    listTtsModels: () => get('/v1/tts-models', ttsModelsSchema),
    // https://soniox.com/docs/api-reference/tts/get_shared_voices.mdx
    listSharedVoices: (model: string) => get(`/v1/shared-voices?model=${encodeURIComponent(model)}&limit=200`, voicesSchema),
    // POST /tts lives on https://tts-rt.soniox.com, not api.soniox.com (404 there), so ttsPath may be a full URL.
    // https://soniox.com/docs/api-reference/tts/generate_tts.mdx
    async previewTts(input: TtsPreviewInput) {
      const response = await requestBinary({
        provider: 'soniox', url: /^https?:\/\//u.test(options.ttsPath) ? options.ttsPath : `${baseUrl}${options.ttsPath}`, method: 'POST',
        headers: {...auth, 'Content-Type': 'application/json'}, body: JSON.stringify(input),
        schema: z.instanceof(Uint8Array), fetchFn: options.fetch,
        ...options.request,
      });
      const contentTypes: Readonly<Record<string, string>> = {
        wav: 'audio/wav', mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac',
        flac: 'audio/flac', pcm_s16le: 'application/octet-stream',
        pcm_f32le: 'application/octet-stream', pcm_mulaw: 'audio/basic', pcm_alaw: 'audio/basic',
      };
      return {audio: response, contentType: contentTypes[input.audio_format] ?? 'application/octet-stream'};
    },
  };
}
