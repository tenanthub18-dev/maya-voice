import {afterEach, describe, expect, it, vi} from 'vitest';

import {register} from '../instrumentation';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe('demo in-process mocks', () => {
  it('answers mock-origin provider calls in-process only when explicitly enabled', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('INTEGRATIONS_MODE', 'mock');
    vi.stubEnv('INTEGRATIONS_MOCK_ORIGIN', 'https://demo.example.com');

    vi.stubEnv('DEMO_INPROCESS_MOCKS', 'false');
    await register();
    expect(globalThis.fetch).toBe(originalFetch);

    vi.stubEnv('DEMO_INPROCESS_MOCKS', 'true');
    await register();
    const response = await globalThis.fetch('https://demo.example.com/api/_mock/telnyx/available_phone_numbers');
    expect(response.status).toBe(200);
  });

  it('never installs in live mode', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('INTEGRATIONS_MODE', 'live');
    vi.stubEnv('DEMO_INPROCESS_MOCKS', 'true');
    await register();
    expect(globalThis.fetch).toBe(originalFetch);
  });
});
