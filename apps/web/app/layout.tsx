import type {Metadata} from 'next';
import type {ReactNode} from 'react';
import {Inter, Noto_Nastaliq_Urdu, Noto_Sans_Devanagari, Noto_Sans_Gurmukhi} from 'next/font/google';
import localFont from 'next/font/local';
import {NextIntlClientProvider} from 'next-intl';
import {getFormatter, getLocale, getMessages} from 'next-intl/server';
import {cookies} from 'next/headers';
import {AppShell} from '@/components/app-shell';
import {getProductName} from '@/lib/brand';
import {createServerAuthProvider} from '@/lib/auth/server';
import {isDemoData} from '@/lib/data';
import {getDataSource} from '@/lib/data';
import {getCurrentRestaurant} from '@/lib/restaurant';
import '@/styles/tokens.css';

// Next.js self-hosted Google fonts: https://nextjs.org/docs/app/api-reference/components/font
const inter = Inter({subsets: ['latin'], variable: '--font-inter', display: 'swap'});
// Bundled Next.js Geist asset: https://github.com/vercel/next.js/tree/canary/packages/next/src/next-devtools/server/font
const display = localFont({src: '../node_modules/next/dist/next-devtools/server/font/geist-latin.woff2', variable: '--font-heading', display: 'swap'});
const urdu = Noto_Nastaliq_Urdu({subsets: ['arabic'], variable: '--font-urdu', display: 'swap'});
const devanagari = Noto_Sans_Devanagari({subsets: ['devanagari'], variable: '--font-devanagari', display: 'swap'});
const gurmukhi = Noto_Sans_Gurmukhi({subsets: ['gurmukhi'], variable: '--font-gurmukhi', display: 'swap'});

// Next.js metadata API: https://nextjs.org/docs/app/api-reference/functions/generate-metadata
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: getProductName(await getLocale()),
    ...((process.env.INTEGRATIONS_MODE ?? 'mock') === 'mock'
      ? {robots: {index: false, follow: false}}
      : {}),
  };
}

export default async function RootLayout({children}: {children: ReactNode}) {
  const auth = await createServerAuthProvider();
  const [locale, messages, user, format] = await Promise.all([getLocale(), getMessages(), auth.getUser(), getFormatter()]);
  const source = getDataSource();
  const supportSession = user?.role === 'platform-admin' ? await source.getActiveSupportSession() : null;
  const restaurant = user?.organizationId
    ? await getCurrentRestaurant()
    : supportSession
      ? await source.getRestaurantById(supportSession.restaurantId)
      : null;
  const productName = getProductName(locale);
  const demo = isDemoData();
  const revisionNonce = restaurant ? (await cookies()).get('live-rev')?.value ?? null : null;
  return (
    <html lang={locale}>
      <body className={`${inter.variable} ${display.variable} ${urdu.variable} ${devanagari.variable} ${gurmukhi.variable}`}>
        <NextIntlClientProvider messages={messages}>
          <AppShell demo={demo} productName={productName} restaurantName={restaurant?.name} restaurantId={restaurant?.id} revisionNonce={revisionNonce} mode={demo ? 'demo' : 'supabase'} supportView={supportSession && restaurant ? {sessionId: supportSession.id, restaurantName: restaurant.name, expiresLabel: format.dateTime(new Date(supportSession.expiresAt), {dateStyle: 'short', timeStyle: 'short'})} : null}>{children}</AppShell>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
