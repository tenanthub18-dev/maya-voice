import {createApiRepository, createPersistentRateLimiter} from '@/lib/api/supabase';
import {createStripeWebhookHandler} from '@/lib/api/webhooks';
import {webhookCredential} from '@/lib/api/webhook-config';
import {apiError} from '@/lib/api/errors';

const limiter = {consume: (key: string) => createPersistentRateLimiter().consume({
  scope: 'webhook:stripe', key, limit: 60, windowSeconds: 60,
})};

export async function POST(request: Request): Promise<Response> {
  if ((process.env.DATA_SOURCE ?? 'mock') === 'supabase' && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return apiError('CONFIGURATION_ERROR', 'This integration is not enabled for the demo', 503);
  }
  return createStripeWebhookHandler({
    repository: createApiRepository(),
    limiter,
    secret: webhookCredential('STRIPE_WEBHOOK_SECRET', 'mock-stripe-webhook-secret'),
  })(request);
}
