'use client';

import {useTranslations} from 'next-intl';

export default function ErrorState({reset}: {error: Error & {digest?: string}; reset: () => void}) {
  const t = useTranslations('state');
  return <section role="alert" className="mx-auto max-w-xl rounded-lg border border-[var(--danger)] bg-[var(--surface)] p-5"><h1 className="text-xl font-semibold">{t('errorTitle')}</h1><p className="mt-2 text-[var(--muted)]">{t('errorBody')}</p><button onClick={reset} className="mt-4 min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{t('retry')}</button></section>;
}
