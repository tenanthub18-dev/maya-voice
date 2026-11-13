import {authorizeApiRequest} from '@/lib/api/auth';
import {createApiRepository} from '@/lib/api/supabase';
import {isFlagEnabled} from '@/lib/feature-flags';
import {createStripeClient} from '@/lib/integrations/stripe';
import {getIntegrationsMode, getProviderBaseUrl} from '@/lib/integrations/mode';

import type {PaymentConnectDependencies} from './_lib';

function required(name: 'NEXT_PUBLIC_APP_URL' | 'STRIPE_SECRET_KEY'): string {
  const value = process.env[name];
  if (value) return value;
  if (getIntegrationsMode() === 'mock') {
    return name === 'NEXT_PUBLIC_APP_URL' ? 'http://localhost:3000' : 'mock-stripe-secret-key';
  }
  throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
}

export function paymentConnectDependencies(): PaymentConnectDependencies {
  return {
    authorize: () => authorizeApiRequest(['owner']),
    isEnabled: (restaurantId) => isFlagEnabled('diner_payments', restaurantId),
    repository: createApiRepository(),
    stripe: createStripeClient({
      apiKey: required('STRIPE_SECRET_KEY'),
      baseUrl: getProviderBaseUrl('stripe'),
    }),
    appUrl: required('NEXT_PUBLIC_APP_URL').replace(/\/+$/u, ''),
  };
}
