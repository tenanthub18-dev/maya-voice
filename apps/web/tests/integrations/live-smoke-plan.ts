import type {Provider} from '@/lib/integrations/mode';

type Environment = Readonly<Record<string, string | undefined>>;

const credentialByProvider: Record<Provider, string> = {
  telnyx: 'TELNYX_API_KEY',
  stripe: 'STRIPE_SECRET_KEY',
  resend: 'RESEND_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  gemini: 'GEMINI_API_KEY',
  soniox: 'SONIOX_API_KEY',
};

export type LiveSmokeDecision =
  | Readonly<{run: false; reason: string}>
  | Readonly<{run: true; allowMutations: boolean}>;

export function liveSmokeDecision(provider: Provider, env: Environment): LiveSmokeDecision {
  const credential = credentialByProvider[provider];
  if (!env[credential]) return {run: false, reason: `missing ${credential}`};
  return {run: true, allowMutations: env.LIVE_SMOKE_ALLOW_MUTATIONS === '1'};
}
