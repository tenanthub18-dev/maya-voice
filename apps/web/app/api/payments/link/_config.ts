import {getIntegrationsMode, type Environment} from '@/lib/integrations/mode';

type PaymentCredential = 'STRIPE_SECRET_KEY' | 'WORKER_HMAC_SECRET';

export function paymentLinkCredential(
  name: PaymentCredential,
  env: Environment = process.env,
): string {
  const value = env[name];
  if (value) return value;
  if (env.NODE_ENV !== 'production' && getIntegrationsMode(env) === 'mock') {
    return `mock-${name.toLowerCase()}`;
  }
  throw new Error(`${name} is required for the payment-link route`);
}
