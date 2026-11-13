import {afterEach, expect, it, vi} from 'vitest';

const factories = vi.hoisted(() => ({repository: vi.fn(), limiter: vi.fn()}));
vi.mock('@/lib/api/supabase', () => ({createApiRepository: factories.repository, createPersistentRateLimiter: factories.limiter}));
afterEach(() => {vi.unstubAllEnvs(); vi.resetModules(); vi.clearAllMocks();});

it('loads the real-data dashboard build without administrator credentials and keeps deferred callbacks closed', async () => {
  vi.stubEnv('DATA_SOURCE', 'supabase');
  vi.stubEnv('INTEGRATIONS_MODE', 'live');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
  factories.limiter.mockImplementation(() => {throw new Error('Administrator key unavailable');});
  const routes = await Promise.all([
    import('@/app/api/webhooks/stripe/route'),
    import('@/app/api/webhooks/resend/route'),
    import('@/app/api/webhooks/telnyx-sms/route'),
  ]);
  expect(factories.limiter).not.toHaveBeenCalled();
  for (const route of routes) {
    const response = await route.POST(new Request('https://app.example.com/callback', {method: 'POST'}));
    expect(response.status).toBe(503);
  }
  expect(factories.repository).not.toHaveBeenCalled();
  expect(factories.limiter).not.toHaveBeenCalled();
});
