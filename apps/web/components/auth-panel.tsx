import Link from 'next/link';
import {useTranslations} from 'next-intl';
import {Input, buttonStyles} from './ui';

type AuthAction = (formData: FormData) => void | Promise<void>;

export function AuthPanel({
  mode,
  mock,
  action,
  errorMessage,
  productName,
}: {
  mode: 'login' | 'signup';
  mock: boolean;
  action?: AuthAction;
  errorMessage?: string;
  productName?: string;
}) {
  const login = mode === 'login';
  const t = useTranslations('auth');
  return (
    <main className="min-h-screen bg-[var(--background)] px-4 py-10 text-[var(--text)]">
      <section className="mx-auto grid w-full max-w-5xl overflow-hidden rounded-2xl border bg-[var(--surface)] shadow-xl md:grid-cols-[0.9fr_1.1fr]">
        <div className="flex flex-col justify-between bg-[var(--accent)] p-8 text-[var(--on-accent)] md:p-12">
          <Link href="/" className="text-lg font-bold tracking-tight">{productName}</Link>
          <div className="py-14">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] opacity-80">{t('eyebrow')}</p>
            <h1 className="mt-4 text-4xl font-semibold leading-tight">{t(login ? 'loginHero' : 'signupHero')}</h1>
            <p className="mt-4 max-w-sm text-base leading-7 opacity-90">{t('description')}</p>
          </div>
          <p className="text-sm opacity-75">{t('languages')}</p>
        </div>

        <div className="p-6 sm:p-10 md:p-12">
          <h2 className="text-2xl font-semibold tracking-tight">{t(login ? 'loginTitle' : 'signupTitle')}</h2>
          {errorMessage && (
            <p role="alert" className="mt-4 rounded-lg border border-[var(--danger)] bg-[var(--surface-raised)] p-3 text-sm text-[var(--danger)]">
              {errorMessage}
            </p>
          )}
          {mock && login && (
            <form action={action} className="mt-7">
              <button name="intent" value="demo" className={buttonStyles('primary', 'w-full')}>{t('login')}</button>
              <p className="mt-2 text-center text-sm text-[var(--muted)]">{t('demoHelp')}</p>
            </form>
          )}

          <div className="my-7 flex items-center gap-3 text-xs uppercase tracking-widest text-[var(--muted)]"><span className="h-px flex-1 bg-[var(--border)]"/><span>{t(mock && login ? 'liveOptions' : 'chooseMethod')}</span><span className="h-px flex-1 bg-[var(--border)]"/></div>

          <form action={action} className="grid gap-4">
            <Input label={t('email')} required name="email" type="email" autoComplete="email"/>
            <Input label={t('password')} required name="password" type="password" autoComplete={login ? 'current-password' : 'new-password'} minLength={8}/>
            <button name="intent" value={login ? 'password' : 'signup'} className={buttonStyles('secondary')}>{t(mock && login ? 'continueEmail' : login ? 'login' : 'createAccount')}</button>
            <button formNoValidate name="intent" value="google" className={buttonStyles('secondary')}>{t('google')}</button>
            <button formNoValidate name="intent" value="magic" className={buttonStyles('quiet')}>{t('magicLink')}</button>
          </form>
          <p className="mt-7 text-center text-sm text-[var(--muted)]">{login ? <>{t('newHere')} <Link className="font-semibold text-[var(--accent-strong)]" href="/signup">{t('signup')}</Link></> : <>{t('alreadyAccount')} <Link className="font-semibold text-[var(--accent-strong)]" href="/login">{t('login')}</Link></>}</p>
        </div>
      </section>
    </main>
  );
}
