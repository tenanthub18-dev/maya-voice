import {AuthPanel} from '@/components/auth-panel';
import {isMockAuth, sanitizeReturnTo} from '@/lib/auth';
import {authenticateAction} from '@/app/auth/actions';
import {getLocale, getTranslations} from 'next-intl/server';
import {getProductName} from '@/lib/brand';

export default async function LoginPage({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const params = await searchParams;
  const t = await getTranslations('auth');
  const returnTo = sanitizeReturnTo(typeof params.returnTo === 'string' ? params.returnTo : undefined);
  const action = async (formData: FormData) => {
    'use server';
    formData.set('returnTo', returnTo);
    await authenticateAction(formData);
  };
  const errorMessage = params.error === 'callback_failed' ? t('callbackFailed') : undefined;
  return <AuthPanel mode="login" mock={isMockAuth()} action={action} errorMessage={errorMessage} productName={getProductName(await getLocale())}/>;
}
