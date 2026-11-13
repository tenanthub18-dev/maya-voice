import {authenticateAction} from '@/app/auth/actions';
import {AuthPanel} from '@/components/auth-panel';
import {isMockAuth} from '@/lib/auth';
import {getLocale} from 'next-intl/server';
import {getProductName} from '@/lib/brand';

export default async function SignupPage() {
  return <AuthPanel mode="signup" mock={isMockAuth()} action={authenticateAction} productName={getProductName(await getLocale())}/>;
}
