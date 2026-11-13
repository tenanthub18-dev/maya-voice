import {afterEach, describe, expect, it, vi} from 'vitest';

const createApiRepository = vi.fn();
vi.mock('@/lib/api/supabase', () => ({
  createApiRepository,
  createPersistentRateLimiter: () => ({consume: vi.fn()}),
}));

describe('Telnyx callback configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('fails closed with 503 when live webhook verification is not configured', async () => {
    vi.stubEnv('INTEGRATIONS_MODE', 'live');
    vi.stubEnv('TELNYX_PUBLIC_KEY', '');
    const {POST} = await import('@/app/api/webhooks/telnyx-sms/route');
    const response = await POST(new Request('http://local/api/webhooks/telnyx-sms', {method: 'POST'}));
    expect(response.status).toBe(503);
    expect(createApiRepository).not.toHaveBeenCalled();
  });
});
