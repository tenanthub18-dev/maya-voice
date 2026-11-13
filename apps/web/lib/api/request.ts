import type {ZodType} from 'zod';

import {apiError} from './errors';

export type ParsedBody<T> =
  | {ok: true; data: T}
  | {ok: false; response: Response};

const MAXIMUM_JSON_BODY_BYTES = 64 * 1_024;

export type LimitedBody = {ok: true; bytes: Uint8Array} | {ok: false; response: Response};

export async function readBodyLimited(request: Request, maximumBytes: number): Promise<LimitedBody> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return {ok: false, response: apiError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413)};
  }
  const reader = request.body?.getReader();
  if (!reader) return {ok: true, bytes: new Uint8Array()};
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return {ok: false, response: apiError('PAYLOAD_TOO_LARGE', 'Request body is too large', 413)};
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {ok: true, bytes};
}

function configuredOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.NEXT_PUBLIC_APP_URL;
  if (!value) return undefined;
  try { return new URL(value).origin; } catch { return undefined; }
}

export function validateMutationOrigin(
  request: Request,
  env: NodeJS.ProcessEnv = process.env,
): Response | undefined {
  const expected = configuredOrigin(env);
  if (!expected) {
    return env.NODE_ENV === 'production'
      ? apiError('INVALID_ORIGIN', 'Request origin is not allowed', 403)
      : undefined;
  }
  const supplied = request.headers.get('origin');
  return supplied === expected
    ? undefined
    : apiError('INVALID_ORIGIN', 'Request origin is not allowed', 403);
}

export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<ParsedBody<T>> {
  const originError = validateMutationOrigin(request);
  if (originError) return {ok: false, response: originError};
  const contentType = request.headers.get('content-type') ?? '';
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    return {ok: false, response: apiError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json', 415)};
  }
  let body: unknown;
  try {
    const limited = await readBodyLimited(request, MAXIMUM_JSON_BODY_BYTES);
    if (!limited.ok) return limited;
    body = JSON.parse(new TextDecoder().decode(limited.bytes)) as unknown;
  } catch {
    return {ok: false, response: apiError('INVALID_JSON', 'Request body must be valid JSON', 400)};
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {ok: false, response: apiError('INVALID_REQUEST', 'Request body is invalid', 400)};
  }
  return {ok: true, data: parsed.data};
}

export function requestIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'unknown';
}
