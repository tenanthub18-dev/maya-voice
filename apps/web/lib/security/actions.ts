import {headers} from 'next/headers';
import {z} from 'zod';

const MAXIMUM_ACTION_BODY_BYTES = 64 * 1_024;

export function assertStrictFormData(form: FormData, allowedKeys: readonly string[]): void {
  let bytes = 0;
  const applicationEntries: Array<[string, FormDataEntryValue]> = [];
  for (const [key, value] of form.entries()) {
    bytes += Buffer.byteLength(key, 'utf8');
    bytes += typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : value.size;
    // React reserves $ACTION_ fields for Server Action transport metadata.
    // https://github.com/facebook/react/blob/942eb80381b96f8410eab1bef1c539bed1ab0eb1/packages/react-client/src/ReactFlightReplyClient.js#L931-L934
    if (!key.startsWith('$ACTION_')) applicationEntries.push([key, value]);
  }
  if (bytes > MAXIMUM_ACTION_BODY_BYTES) throw new Error('Request body is too large');
  const shape = Object.fromEntries(allowedKeys.map((key) => [key, z.unknown().optional()]));
  z.object(shape).strict().parse(Object.fromEntries(applicationEntries));
}

export function assertStrictActionObject(
  value: unknown,
  allowedKeys: readonly string[],
): asserts value is Record<string, unknown> {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAXIMUM_ACTION_BODY_BYTES) {
    throw new Error('Request body is too large');
  }
  const shape = Object.fromEntries(allowedKeys.map((key) => [key, z.unknown().optional()]));
  z.object(shape).strict().parse(value);
}

export function validateActionOrigin(
  requestHeaders: Headers,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.NEXT_PUBLIC_APP_URL;
  if (!configured) return env.NODE_ENV !== 'production';
  let expected: string;
  try { expected = new URL(configured).origin; } catch { return false; }
  return requestHeaders.get('origin') === expected;
}

export async function assertServerActionOrigin(): Promise<void> {
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    if (process.env.NODE_ENV === 'production') throw new Error('Invalid request origin');
    return;
  }
  if (!validateActionOrigin(await headers())) throw new Error('Invalid request origin');
}
