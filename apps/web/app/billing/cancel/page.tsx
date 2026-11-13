import Link from 'next/link';
import {getTranslations} from 'next-intl/server';

import {Card, PageHeader} from '@/components/ui';

export default async function Page() {
  const t = await getTranslations('screens.billing');
  return <><PageHeader eyebrow={t('eyebrow')} title={t('cancelTitle')} description={t('cancelDescription')}/><Card><Link href="/onboarding/7" className="inline-flex min-h-11 items-center rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{t('returnCheckout')}</Link></Card></>;
}
