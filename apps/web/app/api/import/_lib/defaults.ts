import {authorizeApiRequest} from '@/lib/api/auth';
import {TokenBucketRateLimiter} from '@/lib/api/rate-limit';
import {createApiRepository, createPersistentRateLimiter} from '@/lib/api/supabase';
import {createFirecrawlClient} from '@/lib/integrations/firecrawl';
import {createGeminiClient} from '@/lib/integrations/gemini';
import {getIntegrationsMode, getProviderBaseUrl} from '@/lib/integrations/mode';
import {validatePublicRedirectChain} from '@/lib/security/ssrf';

import type {ImportFileDependencies, ImportPostDependencies, ImportStatusDependencies} from './workflow';

const limiter = new TokenBucketRateLimiter({capacity: 20, refillPerSecond: 1});

function integrationValue(name: string, mockValue: string): string {
  const value = process.env[name];
  if (value) return value;
  if (getIntegrationsMode() === 'mock') return mockValue;
  throw new Error(`${name} is required when INTEGRATIONS_MODE=live`);
}

function clients() {
  return {
    firecrawl: createFirecrawlClient({
      baseUrl: getProviderBaseUrl('firecrawl'),
      apiKey: integrationValue('FIRECRAWL_API_KEY', 'mock-firecrawl-key'),
    }),
    gemini: createGeminiClient({
      baseUrl: getProviderBaseUrl('gemini'),
      apiKey: integrationValue('GEMINI_API_KEY', 'mock-gemini-key'),
      model: integrationValue('GEMINI_MODEL_ID', 'mock-gemini-model'),
    }),
  };
}

export function defaultImportPostDependencies(): ImportPostDependencies {
  return {
    authorize: () => authorizeApiRequest(['owner']),
    limiter,
    repository: createApiRepository(),
    firecrawl: clients().firecrawl,
    validateUrl: validatePublicRedirectChain,
    organizationLimiter: createPersistentRateLimiter(),
  };
}

export function defaultImportStatusDependencies(): ImportStatusDependencies {
  const providerClients = clients();
  return {
    authorize: () => authorizeApiRequest(['owner']),
    limiter,
    repository: createApiRepository(),
    firecrawl: providerClients.firecrawl,
    gemini: {
      generateStructured: (input) => providerClients.gemini.generateStructured(input),
    },
    validateUrl: validatePublicRedirectChain,
  };
}

export function defaultImportFileDependencies(): ImportFileDependencies {
  return {
    authorize: () => authorizeApiRequest(['owner']),
    limiter,
    repository: createApiRepository(),
    gemini: clients().gemini,
  };
}
