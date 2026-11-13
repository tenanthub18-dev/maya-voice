import {readdir, readFile} from 'node:fs/promises';
import path from 'node:path';

import {describe, expect, it} from 'vitest';

type Defense = 'auth' | 'signature' | 'bearer' | 'development-only' | 'access-code';

const expectedDefenses: Record<string, Defense> = {
  '%5Fmock/firecrawl/[...path]/route.ts': 'development-only',
  '%5Fmock/gemini/[...path]/route.ts': 'development-only',
  '%5Fmock/resend/[...path]/route.ts': 'development-only',
  '%5Fmock/soniox/[...path]/route.ts': 'development-only',
  '%5Fmock/stripe/[...path]/route.ts': 'development-only',
  '%5Fmock/telnyx/[...path]/route.ts': 'development-only',
  'billing/checkout/route.ts': 'auth',
  'billing/portal/route.ts': 'auth',
  'calls/[id]/recording/route.ts': 'auth',
  'cron/digest/route.ts': 'bearer',
  'cron/retention/route.ts': 'bearer',
  'cron/usage-alerts/route.ts': 'bearer',
  'demo/session/route.ts': 'access-code',
  'import/[id]/route.ts': 'auth',
  'import/file/route.ts': 'auth',
  'import/route.ts': 'auth',
  'payments/connect/route.ts': 'auth',
  'payments/link/route.ts': 'signature',
  'privacy-requests/route.ts': 'auth',
  'soniox/preview/route.ts': 'auth',
  'telnyx/numbers/assign/route.ts': 'auth',
  'telnyx/numbers/buy/route.ts': 'auth',
  'telnyx/numbers/release/route.ts': 'auth',
  'telnyx/numbers/search/route.ts': 'auth',
  'telnyx/numbers/verify-forwarding/route.ts': 'auth',
  'test-call/token/route.ts': 'auth',
  'test-call/offer/route.ts': 'auth',
  'webhooks/resend/route.ts': 'signature',
  'webhooks/stripe/route.ts': 'signature',
  'webhooks/telnyx-sms/route.ts': 'signature',
};

async function routeFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, {withFileTypes: true})) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.name === 'route.ts') output.push(path.relative(root, absolute));
    }
  }
  await visit(root);
  return output.sort();
}

describe('API route protection inventory', () => {
  it('forces every current and newly added route to declare an auth or signature boundary', async () => {
    const root = path.resolve(process.cwd(), 'app/api');
    const files = await routeFiles(root);

    expect(files).toEqual(Object.keys(expectedDefenses).sort());
    expect(Object.values(expectedDefenses).every((defense) =>
      ['auth', 'signature', 'bearer', 'development-only', 'access-code'].includes(defense))).toBe(true);
  });

  it('keeps each declaration connected to its enforcing handler factory', async () => {
    const root = path.resolve(process.cwd(), 'app/api');
    const markers: Record<Defense, RegExp> = {
      auth: /authorizeApiRequest|authorizeRouteHandler|billingRouteDependencies|defaultImport(?:Post|Status|File)Dependencies|numberRouteDependencies|createPrivacyRequestHandler|paymentConnectDependencies/u,
      signature: /create(?:Resend|Stripe|TelnyxSms)WebhookHandler|createPaymentLinkHandler/u,
      bearer: /create(?:DigestCron|Retention|UsageAlertsCron)Handler/u,
      'development-only': /dispatchMockRequest/u,
      'access-code': /timingSafeEqual/u,
    };
    for (const [file, defense] of Object.entries(expectedDefenses)) {
      expect(await readFile(path.join(root, file), 'utf8'), `${file} must enforce ${defense}`)
        .toMatch(markers[defense]);
    }
  });
});
