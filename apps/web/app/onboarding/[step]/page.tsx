import type {Metadata} from 'next';
import {notFound} from 'next/navigation';
import {getTranslations} from 'next-intl/server';
import {OnboardingWizard} from '@/components/onboarding-screen';
import {getDataSource} from '@/lib/data';
import type {OnboardingStep} from '@/lib/data/types';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {saveOnboardingStep} from './actions';

type PageProps = {params: Promise<{step: string}>};

// Next.js route metadata API: https://nextjs.org/docs/app/api-reference/functions/generate-metadata
export async function generateMetadata({params}: PageProps): Promise<Metadata> {
  const step = Number((await params).step);
  if (!Number.isInteger(step) || step < 1 || step > 7) return {};
  const t = await getTranslations('screens.onboarding');
  return {title: t(`steps.${step}.title`)};
}

export default async function Page({params}: PageProps) {
  const value = Number((await params).step);
  if (!Number.isInteger(value) || value < 1 || value > 7) notFound();
  const step = value as OnboardingStep;
  const source = getDataSource();
  const [state, restaurant, hours, menuItems, faqs, agent, slots, phone] = await Promise.all([
    source.getOnboardingState(),
    getCurrentRestaurant(),
    source.listHours(),
    source.listMenuItems(),
    source.listFaqs(),
    source.getAgent(),
    source.getSlotsConfig(),
    source.getPhoneNumber(),
  ]);

  return <OnboardingWizard step={step} state={state} restaurant={restaurant} hours={hours} menuItems={menuItems} faqs={faqs} agent={agent} slots={slots} saveStep={saveOnboardingStep} initialPhone={phone}/>;
}
