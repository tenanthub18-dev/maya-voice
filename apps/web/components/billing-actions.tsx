'use client';

import {useState} from 'react';
import {CreditCard, ExternalLink, RotateCcw} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {z} from 'zod';

const responseSchema = z.object({url: z.string().url()});
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:opacity-50';

class BillingRequestError extends Error {}

async function redirectRequest(path: string, body?: unknown): Promise<string> {
  const response = await fetch(path, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok) {
    throw new BillingRequestError();
  }
  return responseSchema.parse(value).url;
}

function ErrorMessage({message, retry}: {message: string; retry: () => void}) {
  const t = useTranslations('screens.billing');
  return <div className="mt-3"><p role="alert" className="text-sm text-[var(--danger)]">{message}</p><button type="button" className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 font-semibold" onClick={retry}><RotateCcw aria-hidden="true" size={16}/>{t('retry')}</button></div>;
}

export function CheckoutButton({initialPlan, prepare}: {initialPlan: 'starter' | 'growth' | null; prepare: (plan: 'starter' | 'growth') => Promise<void>}) {
  const t = useTranslations('screens.onboarding.plan');
  const [plan, setPlan] = useState<'starter' | 'growth'>(initialPlan ?? 'starter');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const checkout = async () => {
    setBusy(true); setError('');
    try {
      await prepare(plan);
      window.location.assign(await redirectRequest('/api/billing/checkout', {plan}));
    } catch {
      setError(t('error'));
    } finally { setBusy(false); }
  };
  return <div>
    <div className="grid gap-3 sm:grid-cols-2">{(['starter', 'growth'] as const).map((value) => <label key={value} className="rounded-lg border p-4 has-[:checked]:border-[var(--accent)]"><input type="radio" name="plan" value={value} checked={plan === value} onChange={() => setPlan(value)} className="mr-2"/><strong>{t(value)}</strong><p className="mt-1 text-sm text-[var(--muted)]">{t(`${value}Description`)}</p></label>)}</div>
    <button type="button" className={`${buttonClass} mt-4`} disabled={busy} onClick={() => void checkout()}><CreditCard aria-hidden="true" size={18}/>{t('checkout')}</button>
    {error && <ErrorMessage message={error} retry={() => void checkout()}/>}
  </div>;
}

export function BillingPortalButton() {
  const t = useTranslations('screens.billing');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const open = async () => {
    setBusy(true); setError('');
    try { window.location.assign(await redirectRequest('/api/billing/portal')); }
    catch { setError(t('error')); }
    finally { setBusy(false); }
  };
  return <div><button type="button" className={buttonClass} disabled={busy} onClick={() => void open()}><ExternalLink aria-hidden="true" size={17}/>{t('portal')}</button>{error && <ErrorMessage message={error} retry={() => void open()}/>}</div>;
}
