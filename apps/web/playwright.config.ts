import {createServer, type Server} from 'node:net';
import {resolve} from 'node:path';
import {defineConfig} from '@playwright/test';

async function availablePorts(count: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    const ports: number[] = [];
    let settled = false;

    const closeAll = (callback: () => void) => {
      let remaining = servers.length;
      if (remaining === 0) return callback();
      for (const server of servers) {
        server.close(() => {
          remaining -= 1;
          if (remaining === 0) callback();
        });
      }
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      closeAll(() => reject(error));
    };

    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      servers.push(server);
      server.unref();
      server.once('error', fail);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          fail(new Error('Could not allocate Playwright web-server ports'));
          return;
        }
        ports.push(address.port);
        if (ports.length !== count || settled) return;
        settled = true;
        closeAll(() => resolve(ports));
      });
    }
  });
}

const requestedPort = Number(process.env.PLAYWRIGHT_PORT);
const requestedMockPort = Number(process.env.PLAYWRIGHT_MOCK_PORT);
const requestedPortsAreValid = Number.isSafeInteger(requestedPort) && requestedPort > 0
  && Number.isSafeInteger(requestedMockPort) && requestedMockPort > 0
  && requestedPort !== requestedMockPort;
const [port, mockPort] = requestedPortsAreValid
  ? [requestedPort, requestedMockPort]
  : await availablePorts(2);
process.env.PLAYWRIGHT_PORT = String(port);
process.env.PLAYWRIGHT_MOCK_PORT = String(mockPort);
const baseURL = `http://127.0.0.1:${port}`;
const mockBaseURL = `http://127.0.0.1:${mockPort}`;

// Playwright webServer and project configuration:
// https://playwright.dev/docs/test-webserver
// https://playwright.dev/docs/test-projects
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: {timeout: 10_000},
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    permissions: ['microphone'],
    launchOptions: {args: ['--use-fake-device-for-media-stream']},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm build && pnpm exec next start --hostname 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATA_SOURCE: 'mock',
      INTEGRATIONS_MODE: 'mock',
      INTEGRATIONS_MOCK_ORIGIN: mockBaseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      PRIVACY_REQUEST_HASH_SECRET: 'playwright-only-privacy-hash-secret-0123456789',
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: resolve('e2e/google-font-responses.cjs'),
    },
  },
  projects: [
    {name: 'mobile', use: {viewport: {width: 375, height: 812}}},
    {name: 'tablet', use: {viewport: {width: 768, height: 1024}}},
    {name: 'desktop', use: {viewport: {width: 1280, height: 900}}},
  ],
});
