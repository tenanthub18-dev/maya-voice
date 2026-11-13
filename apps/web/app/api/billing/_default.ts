import {authorizeApiRequest} from '@/lib/api/auth';
import {createApiRepository} from '@/lib/api/supabase';
import {createStripeClient} from '@/lib/integrations/stripe';
import {getIntegrationsMode, getProviderBaseUrl} from '@/lib/integrations/mode';

import type {BillingRouteDependencies} from './_lib';

function required(name: 'NEXT_PUBLIC_APP_URL' | 'STRIPE_SECRET_KEY' | 'STRIPE_STARTER_PRICE_ID' | 'STRIPE_GROWTH_PRICE_ID' | 'STRIPE_METERED_PRICE_ID'): string {
  const value = process.env[name];
  if (value) return value;
  if (getIntegrationsMode() === 'mock') {
    if (name === 'NEXT_PUBLIC_APP_URL') return 'http://localhost:3000';
    return `mock-${name.toLowerCase()}`;
  }
  throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
}

export function billingRouteDependencies(): BillingRouteDependencies {
  return {
    authorize: () => authorizeApiRequest(['owner']),
    repository: createApiRepository(),
    stripe: createStripeClient({
      apiKey: required('STRIPE_SECRET_KEY'),
      baseUrl: getProviderBaseUrl('stripe'),
    }),
    appUrl: required('NEXT_PUBLIC_APP_URL').replace(/\/+$/u, ''),
    priceIds: {
      starter: required('STRIPE_STARTER_PRICE_ID'),
      growth: required('STRIPE_GROWTH_PRICE_ID'),
      metered: required('STRIPE_METERED_PRICE_ID'),
    },
  };
}
