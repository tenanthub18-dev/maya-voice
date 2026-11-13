// Next.js server instrumentation hook: https://nextjs.org/docs/app/guides/instrumentation
//
// Demo deployments (INTEGRATIONS_MODE=mock on a production build, e.g. a protected Vercel project) cannot
// reach the dev-only /api/_mock routes over HTTP: they return 404 in production and deployment protection
// blocks self-requests. With DEMO_INPROCESS_MOCKS=true, provider calls aimed at the mock origin are answered
// in-process by the same dispatcher instead. Live mode never installs this.
import {getIntegrationsMode} from '@/lib/integrations/mode';

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.DEMO_INPROCESS_MOCKS !== 'true' || getIntegrationsMode() !== 'mock') return;

  const {mockFetch} = await import('./app/api/_mock/_lib/dispatcher');
  const origin = (process.env.INTEGRATIONS_MOCK_ORIGIN ?? 'http://localhost:3000').replace(/\/+$/u, '');
  const prefix = `${origin}/api/_mock/`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return url.startsWith(prefix) ? mockFetch(input, init) : realFetch(input, init);
  }) as typeof fetch;
}
