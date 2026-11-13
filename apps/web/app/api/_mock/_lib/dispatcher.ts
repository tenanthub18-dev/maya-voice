import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

import type {Provider} from '@/lib/integrations/mode';

type RuntimeOptions = Readonly<{nodeEnv?: string}>;
type FixtureJson = Record<string, unknown>;

const fixtureRoots = [
  resolve(process.cwd(), 'docs/api'),
  resolve(process.cwd(), '../../docs/api'),
];

function fixturePath(provider: Provider, filename: string): string {
  const root = fixtureRoots.find((candidate) => existsSync(candidate));
  if (root === undefined) throw new Error('Could not locate docs/api fixture directory');
  return resolve(root, provider, 'fixtures', filename);
}

function readFixture(provider: Provider, filename: string): FixtureJson {
  return JSON.parse(readFileSync(fixturePath(provider, filename), 'utf8')) as FixtureJson;
}

function providerBody(fixture: FixtureJson): unknown {
  if ('body' in fixture) return fixture.body;
  return Object.fromEntries(
    Object.entries(fixture).filter(([key]) => !key.startsWith('_')),
  );
}

function jsonFixture(provider: Provider, filename: string, status = 200): Response {
  return Response.json(providerBody(readFixture(provider, filename)), {status});
}

function sonioxShape(key: string): Response {
  const fixture = readFixture('soniox', 'rest_models_and_voices_shapes.json');
  const value = fixture[key];
  if (value === undefined) return new Response(null, {status: 404});
  return Response.json(providerBody(value as FixtureJson));
}

function relativePath(url: URL, provider: Provider): string | undefined {
  const prefix = `/api/_mock/${provider}`;
  if (!url.pathname.startsWith(`${prefix}/`) && url.pathname !== prefix) return undefined;
  return url.pathname.slice(prefix.length) || '/';
}

function telnyx(method: string, path: string): Response {
  if (method === 'GET' && path === '/available_phone_numbers') return jsonFixture('telnyx', 'search-numbers.response.json');
  if (method === 'POST' && path === '/number_orders') return jsonFixture('telnyx', 'number-order-create.response.json', 201);
  if (method === 'GET' && path === '/phone_numbers') return jsonFixture('telnyx', 'numbers-list.response.json');
  if (method === 'DELETE' && /^\/phone_numbers\/[^/]+$/u.test(path)) return jsonFixture('telnyx', 'number-delete.response.json');
  if (method === 'PATCH' && /^\/phone_numbers\/[^/]+$/u.test(path)) return jsonFixture('telnyx', 'number-assign-connection.response.json');
  if (method === 'POST' && path === '/messages') return jsonFixture('telnyx', 'messages-send.response.json');
  return unsupported(method, path, ['GET /available_phone_numbers', 'POST /number_orders', 'GET /phone_numbers', 'DELETE /phone_numbers/:id', 'PATCH /phone_numbers/:id', 'POST /messages']);
}

function stripe(method: string, path: string): Response {
  if (method === 'POST' && path === '/v1/accounts') return jsonFixture('stripe', 'accounts.create.standard.response.json');
  if (method === 'GET' && /^\/v1\/accounts\/[^/]+$/u.test(path)) return jsonFixture('stripe', 'accounts.create.standard.response.json');
  if (method === 'POST' && path === '/v1/account_links') return jsonFixture('stripe', 'account_links.create.response.json');
  if (method === 'POST' && path === '/v1/payment_links') return jsonFixture('stripe', 'payment_links.create.response.json');
  if (method === 'POST' && path === '/v1/customers') return jsonFixture('stripe', 'customers.create.response.json');
  if (method === 'POST' && path === '/v1/checkout/sessions') return jsonFixture('stripe', 'checkout.sessions.create.response.subscription_mode.derived.json');
  if (method === 'POST' && path === '/v1/billing_portal/sessions') return jsonFixture('stripe', 'billing_portal.sessions.create.response.json');
  if (method === 'GET' && path === '/v1/invoices') return jsonFixture('stripe', 'invoices.list.response.json');
  if (method === 'POST' && path === '/v1/billing/meter_events') return jsonFixture('stripe', 'billing.meter_events.create.response.json');
  return unsupported(method, path, ['POST /v1/accounts', 'GET /v1/accounts/:id', 'POST /v1/account_links', 'POST /v1/payment_links', 'POST /v1/customers', 'POST /v1/checkout/sessions', 'POST /v1/billing_portal/sessions', 'GET /v1/invoices', 'POST /v1/billing/meter_events']);
}

function resend(method: string, path: string): Response {
  if (method === 'POST' && path === '/emails') return jsonFixture('resend', 'send-email.response.json');
  return unsupported(method, path, ['POST /emails']);
}

function firecrawl(method: string, path: string): Response {
  if (method === 'POST' && path === '/scrape') return jsonFixture('firecrawl', 'scrape.response.json');
  if (method === 'POST' && path === '/crawl') return jsonFixture('firecrawl', 'crawl.start.response.json');
  if (method === 'GET' && /^\/crawl\/[^/]+$/u.test(path)) {
    const fixture = providerBody(readFixture('firecrawl', 'crawl.status.scraping.json')) as FixtureJson;
    // VERIFY: Firecrawl documents the completed status, but the fixture corpus has
    // only a captured scraping response. The mock preserves that payload and moves
    // it to the documented terminal status so the import flow can finish locally.
    // https://docs.firecrawl.dev/api-reference/endpoint/crawl-get
    return Response.json({...fixture, status: 'completed'});
  }
  if (method === 'POST' && path === '/map') return jsonFixture('firecrawl', 'map.response.json');
  if (method === 'POST' && path === '/extract') return jsonFixture('firecrawl', 'extract.start.response.json');
  if (method === 'GET' && /^\/extract\/[^/]+$/u.test(path)) return jsonFixture('firecrawl', 'extract.status.completed.json');
  return unsupported(method, path, ['POST /scrape', 'POST /crawl', 'GET /crawl/:id', 'POST /map', 'POST /extract', 'GET /extract/:id']);
}

async function gemini(method: string, path: string, request: Request): Promise<Response> {
  if (method === 'POST' && /^\/models\/[^/]+:generateContent$/u.test(path)) {
    const fixture = providerBody(readFixture('gemini', 'generate_response.json')) as {
      candidates: Array<{content: {parts: Array<{text?: string}>}}>
    };
    const requestBody = await request.json() as {
      generationConfig?: {responseSchema?: {properties?: Record<string, {type?: string}>}}
    };
    const properties = requestBody.generationConfig?.responseSchema?.properties ?? {};
    const property = Object.entries(properties).find(([, schema]) => schema.type === 'string')?.[0];
    const fixtureText = fixture.candidates[0]?.content.parts[0]?.text;
    if (fixtureText && Object.keys(properties).length > 0) {
      // VERIFY: no captured structured-output response exists. Preserve the complete
      // documented outer fixture. String properties receive its exact text; array
      // properties use empty collections so imports never invent restaurant facts.
      const structured = Object.fromEntries(Object.entries(properties).map(([name, schema]) => [
        name,
        schema.type === 'array' ? [] : schema.type === 'string' ? fixtureText : {},
      ]));
      fixture.candidates[0]!.content.parts[0]!.text = JSON.stringify(
        property === undefined ? structured : {...structured, [property]: fixtureText},
      );
    }
    return Response.json(fixture);
  }
  return unsupported(method, path, ['POST /models/:model:generateContent']);
}

function soniox(method: string, path: string, url: URL): Response {
  if (method === 'GET' && path === '/v1/models') return sonioxShape('GET /v1/models');
  if (method === 'GET' && path === '/v1/tts-models') return sonioxShape('GET /v1/tts-models');
  if (method === 'GET' && path === '/v1/shared-voices' && url.searchParams.has('model')) {
    return sonioxShape('GET /v1/shared-voices?model=tts-rt-v2&limit=200');
  }
  if (method === 'POST' && path === '/tts') {
    // VERIFY live: Soniox documents a raw binary response but publishes no response bytes.
    // https://soniox.com/docs/api-reference/tts/generate_tts.mdx
    const fixture = readFixture('soniox', 'tts_rest_response.generated.json') as {content_type: string; base64: string};
    return new Response(Buffer.from(fixture.base64, 'base64'), {
      headers: {'content-type': fixture.content_type},
    });
  }
  return unsupported(method, path, ['GET /v1/models', 'GET /v1/tts-models', 'GET /v1/shared-voices', 'POST /tts']);
}

function unsupported(method: string, path: string, supported: readonly string[]): Response {
  const pathExists = supported.some((entry) => {
    const supportedPath = entry.slice(entry.indexOf(' ') + 1).replace(/:[^/]+/gu, '[^/]+');
    return new RegExp(`^${supportedPath}$`, 'u').test(path);
  });
  return Response.json({error: pathExists ? 'method_not_allowed' : 'not_found'}, {
    status: pathExists ? 405 : 404,
  });
}

const dispatchers: Record<Provider, (method: string, path: string, url: URL, request: Request) => Response | Promise<Response>> = {
  telnyx: (method, path) => telnyx(method, path),
  stripe: (method, path) => stripe(method, path),
  resend: (method, path) => resend(method, path),
  firecrawl: (method, path) => firecrawl(method, path),
  gemini: (method, path, _url, request) => gemini(method, path, request),
  soniox,
};

/** Mock routes are development-only by contract. */
export async function dispatchMockRequest(
  request: Request,
  provider: Provider,
  runtime: RuntimeOptions = {},
): Promise<Response> {
  if ((runtime.nodeEnv ?? process.env.NODE_ENV) === 'production') {
    return new Response(null, {status: 404});
  }
  const url = new URL(request.url);
  const path = relativePath(url, provider);
  if (path === undefined) return new Response(null, {status: 404});
  return dispatchers[provider](request.method.toUpperCase(), path, url, request);
}

/** Fetch-compatible adapter used by contract tests; route handlers call the same dispatcher. */
export async function mockFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const match = new URL(request.url).pathname.match(/^\/api\/_mock\/(telnyx|stripe|resend|firecrawl|gemini|soniox)(?:\/|$)/u);
  if (match?.[1] === undefined) return new Response(null, {status: 404});
  return dispatchMockRequest(request, match[1] as Provider, {nodeEnv: 'development'});
}
