import {authorizeApiRequest} from '@/lib/api/auth';
import {TokenBucketRateLimiter, rateLimitedResponse} from '@/lib/api/rate-limit';
import {requestIp} from '@/lib/api/request';
import {createApiRepository, createPersistentRateLimiter} from '@/lib/api/supabase';
import {createTelnyxClient} from '@/lib/integrations/telnyx';
import {getIntegrationsMode, getProviderBaseUrl} from '@/lib/integrations/mode';

import type {NumberRoutesDependencies} from './_lib';

const limiter = new TokenBucketRateLimiter({capacity: 20, refillPerSecond: 1});

function requiredLive(name: 'TELNYX_API_KEY' | 'TELNYX_TEXML_APP_ID' | 'TELNYX_MESSAGING_PROFILE_ID'): string {
  const value = process.env[name];
  if (value) return value;
  if (getIntegrationsMode() === 'mock') return `mock-${name.toLowerCase()}`;
  throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
}

export function numberRouteDependencies(): NumberRoutesDependencies {
  return {
    authorize: () => authorizeApiRequest(['owner']),
    consumeRateLimit(request, userId) {
      for (const key of [`ip:${requestIp(request)}`, `user:${userId}`]) {
        const decision = limiter.consume(key);
        if (!decision.allowed) return rateLimitedResponse(decision.retryAfterSeconds);
      }
      return null;
    },
    purchaseLimiter: createPersistentRateLimiter(),
    repository: createApiRepository(),
    telnyx: createTelnyxClient({
      apiKey: requiredLive('TELNYX_API_KEY'),
      baseUrl: getProviderBaseUrl('telnyx'),
    }),
    texmlAppId: requiredLive('TELNYX_TEXML_APP_ID'),
    messagingProfileId: requiredLive('TELNYX_MESSAGING_PROFILE_ID'),
  };
}
