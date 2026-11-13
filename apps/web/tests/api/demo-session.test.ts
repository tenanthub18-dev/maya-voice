import {createHmac} from 'node:crypto';
import {NextRequest} from 'next/server';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {POST} from '@/app/api/demo/session/route';

const code = 'a-strong-test-access-code-12345678';
const secret = 'test-hmac-secret-12345678901234567890';
function request(body: unknown, origin = 'https://demo.example.com') {
  return new NextRequest('https://demo.example.com/api/demo/session', {
    method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.stubEnv('VOICE_DEMO_ACCESS_CODE', code);
  vi.stubEnv('TEST_CALL_HMAC_SECRET', secret);
  vi.stubEnv('VOICE_DEMO_RESTAURANT_ID', 'restaurant-1');
  vi.stubEnv('VOICE_DEMO_AGENT_VERSION_ID', 'draft-1');
  vi.stubEnv('WORKER_BASE_URL', 'https://worker.example.com');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://demo.example.com');
});
afterEach(() => vi.unstubAllEnvs());
it('issues a short-lived single-use token for the configured draft, never caller-supplied IDs', async () => {
  const response = await POST(request({accessCode: code, restaurantId: 'attacker'}));
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toContain('no-store');
  const result = await response.json();
  expect(result.websocketUrl).toBe('wss://worker.example.com/browser-call');
  const [payload, signature] = result.token.split('.');
  expect(signature).toBe(createHmac('sha256', secret).update(payload).digest('hex'));
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  expect(claims).toMatchObject({mode: 'test', transport: 'browser-audio', restaurant_id: 'restaurant-1', agent_version_id: 'draft-1', origin: 'https://demo.example.com'});
  expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  expect(claims.exp).toBeLessThan(Date.now() / 1000 + 61);
  expect(claims.nonce).toMatch(/^[a-f0-9-]{36}$/u);
  expect((await (await POST(request({accessCode: code}))).json()).token).not.toBe(result.token);
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.stringify(result)).not.toContain(code);
});
it('rejects missing or incorrect codes and foreign origins', async () => {
  expect((await POST(request({}))).status).toBe(401);
  expect((await POST(request({accessCode: 'bad'}))).status).toBe(401);
  expect((await POST(request({accessCode: code}, 'https://evil.example.com'))).status).toBe(403);
  expect((await POST(request({accessCode: code}, ''))).status).toBe(403);
});
it('fails closed for missing/weak configuration, unsafe worker URLs and oversized payloads', async () => {
  vi.stubEnv('VOICE_DEMO_ACCESS_CODE', 'short');
  expect((await POST(request({accessCode: 'short'}))).status).toBe(503);
  vi.stubEnv('VOICE_DEMO_ACCESS_CODE', code);
  vi.stubEnv('WORKER_BASE_URL', 'http://public.example.com');
  expect((await POST(request({accessCode: code}))).status).toBe(503);
  vi.stubEnv('WORKER_BASE_URL', 'https://worker.example.com');
  expect((await POST(request({accessCode: 'x'.repeat(5000)}))).status).toBe(413);
});
