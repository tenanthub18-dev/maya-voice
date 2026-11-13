import {createDigestCronHandler, createMockDigestRepository} from './_lib';

function integrationValue(name: 'CRON_SECRET' | 'RESEND_API_KEY' | 'RESEND_FROM_EMAIL', mockValue: string): string {
  const value = process.env[name];
  if (value) return value;
  if ((process.env.INTEGRATIONS_MODE ?? 'mock') === 'mock') return mockValue;
  throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
}

export async function GET(request: Request): Promise<Response> {
  const handler = createDigestCronHandler({
    secret: integrationValue('CRON_SECRET', 'mock-cron-secret'),
    async run() {
      const [{runDailyDigest}, {createDailyDigestRepository}, {createResendClient}, {getProviderBaseUrl}] = await Promise.all([
        import('@/lib/notifications/digest'), import('@/lib/notifications/supabase'),
        import('@/lib/integrations/resend'), import('@/lib/integrations/mode'),
      ]);
      const resend = createResendClient({
        apiKey: integrationValue('RESEND_API_KEY', 'mock-resend-key'),
        baseUrl: getProviderBaseUrl('resend'),
      });
      return runDailyDigest({
        day: new Date().toISOString().slice(0, 10),
        from: integrationValue('RESEND_FROM_EMAIL', 'Receptionist <alerts@example.test>'),
        repository: (process.env.DATA_SOURCE ?? 'mock') === 'mock' ? createMockDigestRepository() : createDailyDigestRepository(),
        sendEmail: (email, options) => resend.sendEmail(email, options),
      });
    },
  });
  return handler(request);
}
