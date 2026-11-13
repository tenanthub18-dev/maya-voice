import {z} from 'zod';

import {requestJson} from '../http';

type Fetch = typeof fetch;
type JsonSchema = Readonly<Record<string, unknown>>;

// VERIFY: field names are documented, but the repository fixture is not a live capture.
const responseSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      role: z.string().optional(),
      parts: z.array(z.object({text: z.string().optional()}).passthrough()),
    }).passthrough(),
    finishReason: z.string().optional(), index: z.number().optional(),
  }).passthrough()).min(1),
  usageMetadata: z.object({
    promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional(),
    thoughtsTokenCount: z.number().optional(), totalTokenCount: z.number().optional(),
  }).passthrough().optional(),
  modelVersion: z.string().optional(), responseId: z.string().optional(),
}).passthrough();

export interface GeminiClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetch?: Fetch;
  request?: {timeoutMs?: number; retries?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number};
}

export interface GenerateStructuredInput<T = unknown> {
  prompt: string;
  inlineData?: {mimeType: string; data: string};
  schema: JsonSchema;
  systemInstruction?: string;
  maxOutputTokens?: number;
  resultSchema?: z.ZodType<T>;
}

export function createGeminiClient(options: GeminiClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');

  return {
    // Legacy generateContent remains supported:
    // https://ai.google.dev/gemini-api/docs/migrate-to-interactions
    async generateStructured<T = unknown>(input: GenerateStructuredInput<T>) {
      const body = {
        ...(input.systemInstruction ? {systemInstruction: {parts: [{text: input.systemInstruction}]}} : {}),
        contents: [{role: 'user', parts: [
          {text: input.prompt},
          // Gemini inline file input supports PDF and image bytes encoded as base64.
          // https://ai.google.dev/gemini-api/docs/file-input-methods#inline_data
          ...(input.inlineData ? [{inlineData: input.inlineData}] : []),
        ]}],
        generationConfig: {
          ...(input.maxOutputTokens === undefined ? {} : {maxOutputTokens: input.maxOutputTokens}),
          // VERIFY: current REST responseFormat spelling is not confirmed for this model.
          // Use the older officially documented responseMimeType/responseSchema form.
          // https://ai.google.dev/gemini-api/docs/structured-output
          responseMimeType: 'application/json',
          responseSchema: input.schema,
        },
      };
      const response = await requestJson({
        provider: 'gemini',
        url: `${baseUrl}/models/${encodeURIComponent(options.model)}:generateContent`,
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'x-goog-api-key': options.apiKey},
        body: JSON.stringify(body), schema: responseSchema, fetchFn: options.fetch,
        retrySafe: true,
        ...options.request,
      });
      const text = response.candidates[0]?.content.parts.map((part) => part.text ?? '').join('');
      if (!text) throw new Error('Gemini structured response contained no text');
      try {
        return {response, json: (input.resultSchema ?? z.unknown()).parse(JSON.parse(text)) as T};
      } catch (error) {
        throw new Error('Gemini structured response was not valid JSON', {cause: error});
      }
    },
  };
}
