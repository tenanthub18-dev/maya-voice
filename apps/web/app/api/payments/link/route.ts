import {createApiRepository} from '@/lib/api/supabase';
import {createStripeClient} from '@/lib/integrations/stripe';
import {getProviderBaseUrl} from '@/lib/integrations/mode';

import {createPaymentLinkHandler} from './_lib';
import {paymentLinkCredential} from './_config';

export function POST(request: Request): Promise<Response> {
  const repository = createApiRepository();
  return createPaymentLinkHandler({
    repository,
    stripe: createStripeClient({apiKey: paymentLinkCredential('STRIPE_SECRET_KEY'), baseUrl: getProviderBaseUrl('stripe')}),
    secret: paymentLinkCredential('WORKER_HMAC_SECRET'),
    isEnabled: (restaurantId) => repository.isDinerPaymentsEnabled(restaurantId),
  })(request);
}
