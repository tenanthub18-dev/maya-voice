'use client';

import {useState} from 'react';
import {Phone, RotateCcw, Search, Trash2} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {z} from 'zod';

import type {PhoneNumber} from '@/lib/data/types';
import {Badge, Card, buttonStyles, inputBase} from './ui';
import {useModalFocus} from './modal-shell';

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type AssignedPhone = Pick<PhoneNumber, 'id' | 'e164' | 'forwardingVerifiedAt'>;

const availableNumberSchema = z.object({phone_number: z.string()}).passthrough();
const searchResponseSchema = z.object({data: z.array(availableNumberSchema)}).passthrough();
const buyResponseSchema = z.object({
  phoneNumberId: z.string(),
  data: z.object({phone_numbers: z.array(z.object({phone_number: z.string()}))}).passthrough(),
}).passthrough();
const forwardingSchema = z.object({verified: z.boolean(), verifiedAt: z.string().nullable()});
class NumberRequestError extends Error {}
class LocalizedNumberError extends Error {
  constructor(readonly localized: string) { super(); }
}

const primaryButton = buttonStyles('primary');
const secondaryButton = buttonStyles('secondary');
const inputClass = inputBase;

async function json<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new NumberRequestError();
  }
  return schema.parse(body);
}

export function NumberLifecycleFlow({restaurantId, initialPhone, request = fetch}: {
  restaurantId: string;
  initialPhone: AssignedPhone | null;
  request?: RequestFn;
}) {
  const t = useTranslations('screens.onboarding.number');
  const [areaCode, setAreaCode] = useState('416');
  const [results, setResults] = useState<Array<{phone_number: string}>>([]);
  const [phone, setPhone] = useState(initialPhone);
  const [verified, setVerified] = useState(initialPhone?.forwardingVerifiedAt !== null && initialPhone !== null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [releaseOpen, setReleaseOpen] = useState(false);
  const [releaseReason, setReleaseReason] = useState('');
  const [auditMessage, setAuditMessage] = useState('');
  const {dialogRef: releaseDialogRef, triggerRef: releaseTriggerRef} = useModalFocus<HTMLDialogElement>(releaseOpen, () => setReleaseOpen(false));

  const post = (path: string, body: unknown) => request(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)});
  const act = async (operation: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof LocalizedNumberError ? cause.localized : t('error')); } finally { setBusy(false); }
  };

  const search = () => act(async () => {
    if (!/^\d{3}$/u.test(areaCode)) throw new LocalizedNumberError(t('areaCodeError'));
    const response = await json(await post('/api/telnyx/numbers/search', {restaurantId, areaCode, limit: 5}), searchResponseSchema);
    setResults(response.data);
  });

  const buy = (e164: string) => act(async () => {
    const order = await json(await post('/api/telnyx/numbers/buy', {restaurantId, phoneNumber: e164}), buyResponseSchema);
    await json(await post('/api/telnyx/numbers/assign', {phoneNumberId: order.phoneNumberId}), z.object({data: z.unknown()}));
    setPhone({id: order.phoneNumberId, e164: order.data.phone_numbers[0]?.phone_number ?? e164, forwardingVerifiedAt: null});
    setResults([]);
  });

  const verify = () => phone && act(async () => {
    const result = await json(await post('/api/telnyx/numbers/verify-forwarding', {phoneNumberId: phone.id}), forwardingSchema);
    setVerified(result.verified);
    if (!result.verified) throw new LocalizedNumberError(t('forwardingNotVerified'));
  });

  const release = () => phone && act(async () => {
    if (!releaseReason.trim()) throw new LocalizedNumberError(t('releaseReasonRequired'));
    await json(await post('/api/telnyx/numbers/release', {phoneNumberId: phone.id, reason: releaseReason.trim()}), z.object({data: z.unknown()}));
    setAuditMessage(t('releasedAudit', {reason: releaseReason.trim()}));
    setPhone(null); setVerified(false); setReleaseOpen(false);
  });

  return <Card>
    <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">{t('heading')}</h2>{phone && <Badge tone={verified ? 'success' : 'warning'}>{verified ? t('verified') : t('notVerified')}</Badge>}</div>
    {error && <div role="alert" className="mt-4 rounded-lg border border-[var(--danger)] p-3 text-[var(--danger)]">{error}</div>}
    {auditMessage && <div role="status" className="mt-4 rounded-lg border p-3">{auditMessage}</div>}
    {!phone ? <>
      <div className="mt-4 flex gap-2"><label className="grow text-sm font-medium"><span className="mb-1 block">{t('areaCode')}</span><input className={inputClass} value={areaCode} onChange={(event) => setAreaCode(event.target.value)} inputMode="numeric" maxLength={3}/></label><button type="button" className={`${primaryButton} self-end`} disabled={busy} onClick={() => void search()}><Search aria-hidden="true" size={17}/>{t('search')}</button></div>
      {error && <button type="button" className={`${secondaryButton} mt-3`} onClick={() => void search()} disabled={busy}><RotateCcw aria-hidden="true" size={17}/>{t('retrySearch')}</button>}
      <ul className="mt-4 space-y-2">{results.map((result) => <li key={result.phone_number} className="flex items-center justify-between rounded-lg border p-3"><span>{result.phone_number}</span><button type="button" className={secondaryButton} disabled={busy} onClick={() => void buy(result.phone_number)}>{t('buyNumber', {number: result.phone_number})}</button></li>)}</ul>
    </> : <>
      <p className="mt-4 text-lg font-semibold">{phone.e164}</p>
      <p className="mt-1 text-sm text-[var(--muted)]">{t('forwardingCheckHelp')}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">{(['bell', 'rogers', 'telus'] as const).map((carrier) => <div key={carrier} className="rounded-lg border p-3"><h3 className="font-semibold">{t(carrier)}</h3><p className="mt-1 text-sm text-[var(--muted)]">{t(`${carrier}Steps`)}</p></div>)}</div>
      <div className="mt-4 flex flex-wrap gap-2"><button type="button" className={primaryButton} onClick={() => void verify()} disabled={busy}><Phone aria-hidden="true" size={17}/>{t('test')}</button><button ref={releaseTriggerRef} type="button" className={secondaryButton} onClick={() => setReleaseOpen(true)} disabled={busy}><Trash2 aria-hidden="true" size={17}/>{t('release')}</button></div>
    </>}
    {releaseOpen && <dialog ref={releaseDialogRef} aria-labelledby="release-title" onCancel={(event) => { event.preventDefault(); setReleaseOpen(false); }} onClose={() => setReleaseOpen(false)} className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-[var(--danger)] bg-[var(--surface)] p-4 text-[var(--text)] backdrop:bg-black/50"><h3 id="release-title" className="font-semibold">{t('confirmRelease')}</h3><label className="mt-3 block text-sm font-medium"><span>{t('releaseReason')}</span><input data-autofocus className={`${inputClass} mt-1`} value={releaseReason} onChange={(event) => setReleaseReason(event.target.value)}/></label><div className="mt-3 flex gap-2"><button type="button" className={primaryButton} onClick={() => void release()} disabled={busy}>{t('confirmRelease')}</button><button type="button" className={secondaryButton} onClick={() => setReleaseOpen(false)}>{t('cancel')}</button></div></dialog>}
  </Card>;
}
