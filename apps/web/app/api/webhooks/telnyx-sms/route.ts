import {createApiRepository, createPersistentRateLimiter} from '@/lib/api/supabase';
import {createTelnyxSmsWebhookHandler} from '@/lib/api/webhooks';
import {webhookCredential} from '@/lib/api/webhook-config';
import {apiError} from '@/lib/api/errors';

const limiter = {consume: (key: string) => createPersistentRateLimiter().consume({
  scope: 'webhook:telnyx-sms', key, limit: 120, windowSeconds: 60,
})};

export async function POST(request: Request): Promise<Response> {
  if ((process.env.DATA_SOURCE ?? 'mock') === 'supabase' && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return apiError('CONFIGURATION_ERROR', 'This integration is not enabled for the demo', 503);
  }
  let publicKey: string;
  try {
    publicKey = webhookCredential('TELNYX_PUBLIC_KEY', Buffer.alloc(32).toString('base64'));
  } catch {
    return apiError('CONFIGURATION_ERROR', 'Telnyx webhook verification unavailable', 503);
  }
  return createTelnyxSmsWebhookHandler({
    repository: createApiRepository(),
    limiter,
    publicKey,
  })(request);
}
