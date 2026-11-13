'use client';

import {useTranslations} from 'next-intl';
import {useEffect, useState} from 'react';
import {z} from 'zod';

import type {CanadianProvince} from '@/lib/data/types';
import {Select} from '@/components/ui';

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RequestType = 'export' | 'delete';
type RequestScope = 'caller' | 'restaurant';

const responseSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['received', 'verified', 'fulfilling', 'completed', 'rejected']),
  requestType: z.enum(['export', 'delete']),
  verification: z.enum(['required', 'verified', 'rejected']),
  dueAt: z.string().datetime(),
  result: z.unknown().optional(),
});
const errorSchema = z.object({error: z.object({code: z.string()})});
const errorKeys = {
  FORBIDDEN: 'forbidden', CONFLICT: 'conflict', NOT_FOUND: 'notFound',
  INVALID_REQUEST: 'invalid', INTERNAL_ERROR: 'internal', RATE_LIMITED: 'internal',
} as const;

export function PrivacyRequestForm({restaurantId, province, canManage = false, request = fetch}: {
  restaurantId: string;
  province: CanadianProvince;
  canManage?: boolean;
  request?: RequestFn;
}) {
  // Quebec Law 25 guidance requires clear consent and gives the privacy officer
  // responsibility for access/rectification requests.
  // https://www.cai.gouv.qc.ca/protection-renseignements-personnels/sujets-et-domaines-dinteret/principaux-changements-loi-25
  const t = useTranslations('privacyRequests');
  const [requestType, setRequestType] = useState<RequestType>('export');
  const [scope, setScope] = useState<RequestScope>('caller');
  const [callerPhone, setCallerPhone] = useState('');
  const [confirmRestaurantDeletion, setConfirmRestaurantDeletion] = useState(false);
  const [busy, setBusy] = useState(false);
  const [record, setRecord] = useState<z.infer<typeof responseSchema> | null>(null);
  const [error, setError] = useState('');
  const [verificationMethod, setVerificationMethod] = useState<'callback' | 'account-record' | 'written-document'>('callback');
  const [verificationReference, setVerificationReference] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [queue, setQueue] = useState<z.infer<typeof responseSchema>[]>([]);

  useEffect(() => {
    if (!canManage) return;
    let active = true;
    void request('/api/privacy-requests', {method: 'GET'}).then(async (response) => {
      const body: unknown = await response.json();
      const parsed = z.object({requests: z.array(responseSchema)}).safeParse(body);
      if (active && response.ok && parsed.success) setQueue(parsed.data.requests);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [canManage, request]);

  const submit = async () => {
    setBusy(true);
    setRecord(null);
    setError('');
    try {
      const response = await request('/api/privacy-requests', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(scope === 'restaurant'
          ? {restaurantId, scope, requestType, ...(requestType === 'delete' ? {confirmRestaurantDeletion} : {})}
          : {restaurantId, callerPhone, requestType}),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(body);
        const key = parsed.success ? errorKeys[parsed.data.error.code as keyof typeof errorKeys] : undefined;
        setError(t(`errors.${key ?? 'internal'}`));
        return;
      }
      setRecord(responseSchema.parse(body));
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  };

  const transition = async (action: 'verify' | 'fulfill' | 'reject') => {
    if (!record) return;
    setBusy(true);
    setError('');
    try {
      const response = await request('/api/privacy-requests', {
        method: 'PATCH', headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          requestId: record.id, action,
          ...(action === 'verify' ? {verificationMethod, verificationReference} : {}),
          ...(action === 'reject' ? {reason: rejectionReason} : {}),
          ...(action === 'fulfill' ? {restaurantId, callerPhone} : {}),
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const parsed = errorSchema.safeParse(body);
        const key = parsed.success ? errorKeys[parsed.data.error.code as keyof typeof errorKeys] : undefined;
        setError(t(`errors.${key ?? 'internal'}`));
        return;
      }
      setRecord(responseSchema.parse(body));
      setQueue((current) => current.map((item) => item.id === record.id ? responseSchema.parse(body) : item));
    } catch {
      setError(t('error'));
    } finally {
      setBusy(false);
    }
  };

  return <div className="mt-6 border-t pt-5">
    <h3 className="font-semibold">{t('title')}</h3>
    <p className="mt-1 text-sm text-[var(--muted)]">{t('description')}</p>
    <p className="mt-2 text-sm text-[var(--muted)]">{t(province === 'QC' ? 'law25Help' : 'pipedaHelp')}</p>
    {canManage && queue.length > 0 && <div className="mt-4"><h4 className="font-semibold">{t('queue')}</h4><ul className="mt-2 grid gap-2">{queue.map((item) => <li key={item.id}><button type="button" onClick={() => setRecord(item)} className="min-h-11 w-full rounded-lg border px-3 text-left">{t('queueItem', {id: item.id.slice(0, 8), status: t(`statuses.${item.status}`)})}</button></li>)}</ul></div>}
    <form aria-label={t('formLabel')} onSubmit={(event) => { event.preventDefault(); void submit(); }} className="mt-4 grid gap-3">
      {canManage && <Select label={t('scope')} value={scope} onChange={(event) => setScope(event.target.value as RequestScope)}>
          <option value="caller">{t('callerScope')}</option>
          <option value="restaurant">{t('restaurantScope')}</option>
      </Select>}
      <Select label={t('requestType')} value={requestType} onChange={(event) => setRequestType(event.target.value as RequestType)}>
          <option value="export">{t('export')}</option>
          <option value="delete">{t('delete')}</option>
      </Select>
      {scope === 'caller' && <label className="grid gap-1 text-sm font-medium">{t('callerPhone')}
        <input required type="tel" inputMode="tel" autoComplete="tel" value={callerPhone} onChange={(event) => setCallerPhone(event.target.value)} aria-describedby="privacy-phone-help" className="min-h-11 rounded-lg border bg-[var(--background)] px-3"/>
      </label>}
      {scope === 'caller' && <p id="privacy-phone-help" className="text-xs text-[var(--muted)]">{t('phoneHelp')}</p>}
      {scope === 'restaurant' && <p className="text-sm text-[var(--danger)]">{t('restaurantWarning')}</p>}
      {scope === 'restaurant' && requestType === 'delete' && <label className="flex items-start gap-3 text-sm font-medium"><input required type="checkbox" checked={confirmRestaurantDeletion} onChange={(event) => setConfirmRestaurantDeletion(event.target.checked)} className="mt-1 size-5"/><span>{t('confirmRestaurantDeletion')}</span></label>}
      {requestType === 'delete' && <p className="text-sm text-[var(--muted)]">{t('deleteRetention')}</p>}
      <button disabled={busy || (scope === 'restaurant' && requestType === 'delete' && !confirmRestaurantDeletion)} className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:opacity-60">{t(busy ? 'submitting' : 'submit')}</button>
    </form>
    {record && <div role="status" className="mt-3 space-y-3 rounded-lg border border-[var(--success)] p-3 text-sm text-[var(--success)]">
      <p>{t('success')}</p>
      <p><strong>{t('requestId')}:</strong> {record.id}</p>
      <p><strong>{t('statusLabel')}:</strong> {t(`statuses.${record.status}`)}</p>
      <p><strong>{t('dueAt')}:</strong> {new Intl.DateTimeFormat(undefined, {dateStyle: 'medium'}).format(new Date(record.dueAt))}</p>
      {canManage && record.status === 'received' && <div className="grid gap-2">
        <Select label={t('verificationMethod')} value={verificationMethod} onChange={(event) => setVerificationMethod(event.target.value as typeof verificationMethod)}><option value="callback">{t('verificationMethods.callback')}</option><option value="account-record">{t('verificationMethods.accountRecord')}</option><option value="written-document">{t('verificationMethods.writtenDocument')}</option></Select>
        <label className="grid gap-1 font-medium">{t('verificationReference')}<input value={verificationReference} onChange={(event) => setVerificationReference(event.target.value)} className="min-h-11 rounded-lg border bg-[var(--background)] px-3"/></label>
        <p className="text-xs text-[var(--muted)]">{t('verificationHelp')}</p>
        <button type="button" disabled={busy || verificationReference.trim().length < 4} onClick={() => void transition('verify')} className="min-h-11 rounded-lg border px-4 font-semibold disabled:opacity-60">{t('verify')}</button>
        <label className="grid gap-1 font-medium">{t('rejectionReason')}<textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} className="rounded-lg border bg-[var(--background)] p-3"/></label>
        <button type="button" disabled={busy || rejectionReason.trim().length < 1} onClick={() => void transition('reject')} className="min-h-11 rounded-lg border border-[var(--danger)] px-4 font-semibold text-[var(--danger)] disabled:opacity-60">{t('reject')}</button>
      </div>}
      {canManage && (record.status === 'verified' || record.status === 'fulfilling') && <button type="button" disabled={busy} onClick={() => void transition('fulfill')} className="min-h-11 rounded-lg border px-4 font-semibold disabled:opacity-60">{t('fulfill')}</button>}
      {record.status === 'completed' && record.result !== undefined && <div className="grid gap-2"><a download={`privacy-request-${record.id}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(record.result, null, 2))}`} className="inline-flex min-h-11 items-center font-semibold underline">{t('download')}</a><details><summary className="cursor-pointer font-semibold">{t('result')}</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(record.result, null, 2)}</pre></details></div>}
    </div>}
    {error && <div role="alert" className="mt-3 rounded-lg border border-[var(--danger)] p-3 text-sm text-[var(--danger)]">{error}</div>}
  </div>;
}
