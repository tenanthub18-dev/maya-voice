import {authorizeApiRequest} from '@/lib/api/auth';
import {createApiRepository} from '@/lib/api/supabase';
import {rateLimitedResponse, TokenBucketRateLimiter} from '@/lib/api/rate-limit';

import {createPrivacyRequestHandler} from './_lib';

const limiter = new TokenBucketRateLimiter({capacity: 10, refillPerSecond: 0.1});

function limited(request: Request): Response | undefined {
  const key = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const decision = limiter.consume(key);
  return decision.allowed ? undefined : rateLimitedResponse(decision.retryAfterSeconds);
}

function hashSecret(): string {
  const value = process.env.PRIVACY_REQUEST_HASH_SECRET;
  if (!value || Buffer.byteLength(value, 'utf8') < 32) throw new Error('PRIVACY_REQUEST_HASH_SECRET must be at least 32 bytes');
  return value;
}

export async function POST(request: Request): Promise<Response> {
  const rateLimit = limited(request);
  if (rateLimit) return rateLimit;
  return createPrivacyRequestHandler({
    authorize: () => authorizeApiRequest(['owner', 'staff']),
    repository: createApiRepository(),
    hashSecret: hashSecret(),
  })(request);
}

export async function GET(request: Request): Promise<Response> {
  const rateLimit = limited(request);
  if (rateLimit) return rateLimit;
  return createPrivacyRequestHandler({
    authorize: () => authorizeApiRequest(['owner', 'staff']), repository: createApiRepository(), hashSecret: hashSecret(),
  })(request);
}

export async function PATCH(request: Request): Promise<Response> {
  const rateLimit = limited(request);
  if (rateLimit) return rateLimit;
  return createPrivacyRequestHandler({
    authorize: () => authorizeApiRequest(['owner', 'staff']),
    repository: createApiRepository(),
    hashSecret: hashSecret(),
  })(request);
}
