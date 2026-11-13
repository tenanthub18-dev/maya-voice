import {authorizeApiRequest} from '@/lib/api/auth';
import {createSonioxClient} from '@/lib/integrations/soniox';
import {getIntegrationsMode, getProviderBaseUrl} from '@/lib/integrations/mode';
import {createVoicePreviewHandler} from './_lib';

function value(name: 'SONIOX_API_KEY' | 'SONIOX_TTS_MODEL_ID' | 'SONIOX_TTS_PATH' | 'SONIOX_VOICE_ID', mockValue: string): string {
  const configured = process.env[name];
  if (configured) return configured;
  if (getIntegrationsMode() === 'mock') return mockValue;
  throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
}

const handler = () => createVoicePreviewHandler({
  authorize: () => authorizeApiRequest(['owner']),
  soniox: createSonioxClient({
    baseUrl: getProviderBaseUrl('soniox'),
    apiKey: value('SONIOX_API_KEY', 'mock-soniox-key'),
    ttsPath: value('SONIOX_TTS_PATH', '/tts'),
  }),
  model: value('SONIOX_TTS_MODEL_ID', 'tts-rt-v2'),
  // VERIFY live against GET /v1/shared-voices before publishing.
  // https://soniox.com/docs/api-reference/tts/get_shared_voices.mdx
  voice: value('SONIOX_VOICE_ID', 'Priya'),
});

export const GET = (request: Request) => handler()(request);
export const POST = (request: Request) => handler()(request);
