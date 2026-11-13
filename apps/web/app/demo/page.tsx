import {BrowserDemo} from '@/components/browser-demo';
import {getLocale} from 'next-intl/server';

export default async function BrowserDemoPage() {
  // Existing next-intl server API: https://next-intl.dev/docs/usage/configuration#locale
  return <BrowserDemo locale={await getLocale()} restaurantName={process.env.VOICE_DEMO_RESTAURANT_NAME} restaurantAddress={process.env.VOICE_DEMO_RESTAURANT_ADDRESS}/>;
}
