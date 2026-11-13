import {createHash, createHmac, randomUUID, timingSafeEqual} from 'node:crypto';
import {NextResponse, type NextRequest} from 'next/server';

export const runtime = 'nodejs';

function reply(body: object, status: number) {
  return NextResponse.json(body, {status, headers: {'Cache-Control': 'no-store'}});
}

export async function POST(request: NextRequest) {
  const accessCode = process.env.VOICE_DEMO_ACCESS_CODE;
  const secret = process.env.TEST_CALL_HMAC_SECRET;
  const restaurantId = process.env.VOICE_DEMO_RESTAURANT_ID;
  const agentVersionId = process.env.VOICE_DEMO_AGENT_VERSION_ID;
  let worker: URL;
  let appOrigin: string;
  try {
    worker = new URL(process.env.WORKER_BASE_URL ?? '');
    appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').origin;
    if (worker.username || worker.password || worker.search || worker.hash ||
      (worker.protocol !== 'https:' && !(worker.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(worker.hostname)))) throw new Error('worker URL');
  } catch {
    return reply({error: 'Voice demo is not configured yet.'}, 503);
  }
  if (!accessCode || accessCode.length < 24 || !secret || secret.length < 32 || !restaurantId || !agentVersionId) {
    return reply({error: 'Voice demo is not configured yet.'}, 503);
  }
  // Require the deployed app's exact origin; never mint tokens for arbitrary preview hosts.
  // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Origin
  if (request.headers.get('origin') !== appOrigin) return reply({error: 'Origin is not allowed.'}, 403);
  if (Number(request.headers.get('content-length') ?? 0) > 4096) return reply({error: 'Request is too large.'}, 413);
  const reader = request.body?.getReader();
  if (!reader) return reply({error: 'Invalid request.'}, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return reply({error: 'Request is too large.'}, 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const raw = Buffer.concat(chunks).toString('utf8');
  let supplied: unknown;
  try { supplied = (JSON.parse(raw) as {accessCode?: unknown})?.accessCode; } catch { return reply({error: 'Invalid request.'}, 400); }
  // Hash both operands to equal length before constant-time comparison.
  // https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b
  if (typeof supplied !== 'string' || !timingSafeEqual(createHash('sha256').update(supplied).digest(), createHash('sha256').update(accessCode).digest())) {
    return reply({error: 'Please check your access code.'}, 401);
  }
  const claims = {
    exp: Math.floor(Date.now() / 1000) + 60, mode: 'test', transport: 'browser-audio',
    restaurant_id: restaurantId, agent_version_id: agentVersionId, origin: appOrigin, nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = `${payload}.${createHmac('sha256', secret).update(payload).digest('hex')}`;
  worker.protocol = worker.protocol === 'https:' ? 'wss:' : 'ws:';
  worker.pathname = '/browser-call';
  return reply({token, websocketUrl: worker.toString()}, 200);
}
