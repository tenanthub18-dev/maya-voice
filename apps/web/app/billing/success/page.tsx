import Link from 'next/link';
import {CheckCircle2} from 'lucide-react';
import {getTranslations} from 'next-intl/server';

import {Card, PageHeader} from '@/components/ui';

export default async function Page() {
  const t = await getTranslations('screens.billing');
  return <><PageHeader eyebrow={t('eyebrow')} title={t('successTitle')} description={t('successDescription')}/><Card className="text-center"><CheckCircle2 aria-hidden="true" className="mx-auto text-[var(--success)]" size={44}/><Link href="/settings" className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{t('settings')}</Link></Card></>;
}
