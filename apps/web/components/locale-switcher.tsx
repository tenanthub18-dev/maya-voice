'use client';

import {Languages} from 'lucide-react';
import {useLocale, useTranslations} from 'next-intl';
import {useRouter} from 'next/navigation';

export function LocaleSwitcher() {
  const locale = useLocale();
  const router = useRouter();
  const t = useTranslations('locale');
  return (
    <label className="flex min-h-11 items-center gap-2 rounded-lg border bg-[var(--surface)] px-3 text-sm text-[var(--muted)]">
      <Languages aria-hidden="true" size={18} />
      <span className="sr-only">{t('label')}</span>
      <select
        aria-label={t('label')}
        className="min-h-11 bg-transparent text-[var(--text)] outline-none"
        value={locale}
        onChange={(event) => {
          document.cookie = `locale=${event.target.value};path=/;max-age=31536000;samesite=lax`;
          router.refresh();
        }}
      >
        <option value="en">{t('english')}</option>
        <option value="fr">{t('french')}</option>
      </select>
    </label>
  );
}
