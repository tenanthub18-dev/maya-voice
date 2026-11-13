'use client';

import {useTranslations} from 'next-intl';
import {useEffect} from 'react';
import {webLogger} from '@/lib/logger';
import {ErrorState as SharedErrorState} from '@/components/ui';

export default function ErrorState({error, reset}: {error: Error & {digest?: string}; reset: () => void}) {
  const t = useTranslations('state');
  useEffect(() => { webLogger.error(error); }, [error]);
  return <div role="alert"><SharedErrorState title={t('errorTitle')} message={t('errorBody')} retryLabel={t('retry')} onRetry={reset}/></div>;
}
