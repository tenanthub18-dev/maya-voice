import {defineConfig, globalIgnores} from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTypescript from 'eslint-config-next/typescript';

// Next.js flat ESLint configuration: https://nextjs.org/docs/app/api-reference/config/eslint
export default defineConfig([
  ...nextVitals,
  ...nextTypescript,
  {
    rules: {
      'no-restricted-syntax': ['error', {
        selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
        message: 'Render untrusted text through React escaping; raw HTML is forbidden.',
      }],
    },
  },
  {
    files: ['app/**/*.tsx', 'components/**/*.{ts,tsx}', 'lib/data/supabase/client.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          {name: '@/lib/api/supabase', message: 'Service-role Supabase access is server-only.'},
          {name: '@/lib/data/supabase/service', message: 'Service-role Supabase access is server-only.'},
          {name: '@/lib/notifications/supabase', message: 'Service-role Supabase access is server-only.'},
        ],
      }],
    },
  },
  globalIgnores(['.next/**', '.next-*/**', 'next-env.d.ts'])
]);
