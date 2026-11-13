import {resolve} from 'node:path';
import createNextIntlPlugin from 'next-intl/plugin';

import {STATIC_SECURITY_HEADERS} from './lib/security/headers';

// next-intl App Router setup: https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

export default withNextIntl({
  reactStrictMode: true,
  // Isolate the local real-data test from another running dev server:
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/distDir
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // The in-process mock dispatcher reads provider fixtures from docs/api at runtime:
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/output#caveats
  outputFileTracingRoot: resolve(import.meta.dirname, '../..'),
  outputFileTracingIncludes: {'/**': ['../../docs/api/**/*']},
  async headers() {
    const headers: Array<{key: string; value: string}> = [...STATIC_SECURITY_HEADERS];
    if ((process.env.INTEGRATIONS_MODE ?? 'mock') === 'mock') {
      headers.push({key: 'X-Robots-Tag', value: 'noindex, nofollow'});
    }
    return [{source: '/(.*)', headers}];
  },
});
