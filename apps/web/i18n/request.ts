import {cookies} from 'next/headers';
import {getRequestConfig} from 'next-intl/server';

export const locales = ['en', 'fr'] as const;
export type Locale = (typeof locales)[number];

// Cookie-based routing keeps product URLs unprefixed: https://next-intl.dev/docs/getting-started/app-router/without-i18n-routing
export default getRequestConfig(async () => {
  const value = (await cookies()).get('locale')?.value;
  const locale: Locale = value === 'fr' ? 'fr' : 'en';
  return {locale, messages: (await import(`../messages/${locale}.json`)).default};
});
