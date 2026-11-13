import {demoLoginAction} from '@/app/auth/actions';
import {LandingPageContent} from '@/components/landing-page';
import {isMockAuth} from '@/lib/auth';
import {BRAND, getProductName} from '@/lib/brand';
import {getLocale} from 'next-intl/server';

export default async function IndexPage() {
  return <LandingPageContent mock={isMockAuth()} demoAction={demoLoginAction} productName={getProductName(await getLocale())} personaName={BRAND.defaultPersonaName}/>;
}
