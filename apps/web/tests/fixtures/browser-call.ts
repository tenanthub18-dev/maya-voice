import type {Call} from '@/lib/data/types';
import {getMockSeed} from '@/lib/data/mock';

export function browserCall(overrides: Partial<Call> = {}): Call {
  return {
    ...getMockSeed().calls[0], id: 'browser-call', source: 'browser',
    telnyxCallId: null, fromE164Hash: null, fromLast4: null,
    startedAt: '2026-11-12T12:00:00.000Z', endedAt: '2026-11-12T12:01:05.000Z',
    billableSeconds: 0, outcome: 'answered', summary: '', recordingPath: null,
    qaFlags: [], costMicros: {llm: 600, tts: 100},
    usage: {
      schema_version: 1, currency: 'USD', cost_status: 'partial', usage_complete: true,
      rate_as_of: '2026-11-12',
      totals: {prompt_tokens: 1000, completion_tokens: 200, cache_read_input_tokens: 400, total_tokens: 1200, audio_seconds: 60, characters: 100, generated_audio_seconds: 1},
      services: [
        {kind: 'llm', model: 'actual-llm', cost_micros: 600, cost_basis: 'reported_text_tokens', cost_status: 'estimated', processor: 'llm', reported_events: 1, units: {prompt_tokens: 1000, completion_tokens: 200, cache_read_input_tokens: 400, total_tokens: 1200}},
        {kind: 'stt', model: 'actual-stt', cost_micros: null, cost_basis: 'unpriced_model', cost_status: 'unavailable', processor: 'stt', reported_events: 1, units: {audio_seconds: 60}},
        {kind: 'tts', model: 'actual-tts', cost_micros: 100, cost_basis: 'estimated_text_and_audio', cost_status: 'estimated', processor: 'tts', reported_events: 1, units: {characters: 100, generated_audio_seconds: 1}},
      ],
    },
    ...overrides,
  };
}
