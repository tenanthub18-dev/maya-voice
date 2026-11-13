import Link from 'next/link';
import {ArrowRight, CalendarCheck, Languages, PhoneCall} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {Card, buttonStyles} from './ui';

type DemoAction = (formData: FormData) => void | Promise<void>;

const languages = ['en', 'fr', 'ur', 'hi', 'pa'] as const;

export function LandingPageContent({mock, demoAction, productName, personaName}: {mock: boolean; demoAction?: DemoAction; productName?: string; personaName?: string}) {
  const t = useTranslations('landing');
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--text)]">
      <header className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5 md:px-8">
        <span className="text-lg font-bold tracking-tight">{productName}</span>
        <div className="flex items-center gap-2">
          {mock ? <form action={demoAction}><button name="intent" value="demo" className={buttonStyles('quiet')}>{t('login')}</button></form> : <Link className={buttonStyles('quiet')} href="/login">{t('login')}</Link>}
          <Link className={buttonStyles('primary')} href="/signup">{t('signup')}</Link>
        </div>
      </header>

      <section className="mx-auto grid max-w-7xl items-center gap-12 px-5 pb-20 pt-14 md:grid-cols-[1.15fr_0.85fr] md:px-8 md:pb-28 md:pt-24">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--accent-strong)]">{t('eyebrow')}</p>
          <h1 className="mt-5 max-w-4xl text-[length:var(--text-4xl)] font-semibold leading-[.98] tracking-[-.045em]">{t('title')}</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-[var(--muted)]">{t('description', {persona: personaName ?? ''})}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {mock ? <form action={demoAction}><button name="intent" value="demo" className={buttonStyles('primary')}>{t('login')} <ArrowRight aria-hidden size={18}/></button></form> : <Link href="/signup" className={buttonStyles('primary')}>{t('trial')} <ArrowRight aria-hidden size={18}/></Link>}
            <Link href="/signup" className={buttonStyles('secondary')}>{t('signup')}</Link>
          </div>
        </div>
        <Card className="p-6 shadow-[var(--shadow-2)]">
          <p className="text-sm font-semibold text-[var(--muted)]">{t('try')}</p>
          <div className="mt-4 flex items-center gap-4 rounded-xl bg-[var(--surface-raised)] p-5"><span className="grid size-12 place-items-center rounded-full bg-[var(--accent-soft)] text-[var(--accent-strong)]"><PhoneCall aria-hidden/></span><div><p className="text-xl font-semibold">{t('demoSoon')}</p><p className="mt-1 text-sm text-[var(--muted)]">{t('demoHelp')}</p></div></div>
          <div className="mt-6 grid grid-cols-2 gap-3"><div className="rounded-xl border p-4"><CalendarCheck className="text-[var(--accent-strong)]" aria-hidden/><p className="mt-3 font-semibold">{t('books')}</p></div><div className="rounded-xl border p-4"><Languages className="text-[var(--accent-strong)]" aria-hidden/><p className="mt-3 font-semibold">{t('switches')}</p></div></div>
        </Card>
      </section>

      <section className="border-y bg-[var(--surface)]"><div className="mx-auto max-w-7xl px-5 py-16 md:px-8"><p className="text-center text-sm font-semibold uppercase tracking-[0.18em] text-[var(--muted)]">{t('languagesHeading')}</p><div className="mt-7 flex flex-wrap justify-center gap-3">{languages.map((language) => <span key={language} dir="auto" className="rounded-full border bg-[var(--background)] px-4 py-2 font-medium">{t(`languages.${language}`)}</span>)}</div></div></section>

      <section className="mx-auto max-w-4xl px-5 py-20 md:px-8"><p className="text-sm font-semibold uppercase tracking-[0.18em] text-[var(--accent-strong)]">{t('pricing')}</p><h2 className="mt-3 font-display text-4xl font-semibold tracking-tight">{t('price')}</h2><Link href="/signup" className={buttonStyles('primary', 'mt-7')}>{t('create')}</Link></section>
    </main>
  );
}
