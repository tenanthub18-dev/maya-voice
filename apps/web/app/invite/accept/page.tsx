import {redirect} from 'next/navigation';
import {getTranslations} from 'next-intl/server';

import {acceptInvitationAction} from '@/app/invite/actions';
import {createServerAuthProvider} from '@/lib/auth/server';

export default async function AcceptInvitationPage({searchParams}: {searchParams: Promise<{token?: string}>}) {
  const t = await getTranslations('invite');
  const token = (await searchParams).token;
  if (!token) return <main className="mx-auto max-w-lg px-5 py-20"><h1 className="text-3xl font-semibold">{t('invalidTitle')}</h1><p className="mt-3 text-[var(--muted)]">{t('invalidBody')}</p></main>;
  const user = await (await createServerAuthProvider()).getUser();
  if (!user) redirect(`/login?returnTo=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
  return <main className="mx-auto max-w-lg px-5 py-20"><div className="rounded-2xl border bg-[var(--surface)] p-8 shadow-xl"><p className="text-sm font-semibold uppercase tracking-widest text-[var(--accent-strong)]">{t('eyebrow')}</p><h1 className="mt-3 text-3xl font-semibold">{t('title')}</h1><p className="mt-3 text-[var(--muted)]">{t('signedIn', {email: user.email})}</p><form action={acceptInvitationAction} className="mt-7"><input type="hidden" name="token" value={token}/><button className="min-h-12 w-full rounded-lg bg-[var(--accent)] px-5 font-semibold text-[var(--on-accent)]">{t('accept')}</button></form></div></main>;
}
