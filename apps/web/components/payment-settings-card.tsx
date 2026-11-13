'use client';

import {CreditCard, RotateCcw} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {useCallback, useEffect, useState} from 'react';

import {Badge, Card, buttonStyles} from './ui';

type ConnectionStatus = 'not_connected' | 'pending' | 'ready';
type Request = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ConnectionResponse {
  status?: ConnectionStatus;
  url?: string;
  error?: {code?: string; message?: string};
}

export function PaymentSettingsCard({request = fetch}: {request?: Request}) {
  const t = useTranslations('screens.settings.payments');
  const [status, setStatus] = useState<ConnectionStatus>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await request('/api/payments/connect');
      setError(false);
      const body = await response.json() as ConnectionResponse;
      if (!response.ok || !body.status) throw new Error(body.error?.code ?? 'payment_connection_failed');
      setStatus(body.status);
    } catch {
      setError(true);
    }
  }, [request]);

  useEffect(() => {
    let active = true;
    void request('/api/payments/connect')
      .then(async (response) => {
        const body = await response.json() as ConnectionResponse;
        if (!response.ok || !body.status) throw new Error(body.error?.code ?? 'payment_connection_failed');
        if (active) {
          setError(false);
          setStatus(body.status);
        }
      })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [request]);

  async function connect() {
    setBusy(true);
    setError(false);
    try {
      const response = await request('/api/payments/connect', {method: 'POST'});
      const body = await response.json() as ConnectionResponse;
      if (!response.ok || !body.url) throw new Error(body.error?.code ?? 'payment_connection_failed');
      window.location.assign(body.url);
    } catch {
      setError(true);
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError(false);
    try {
      const response = await request('/api/payments/connect', {method: 'DELETE'});
      const body = await response.json() as ConnectionResponse;
      if (!response.ok || body.status !== 'not_connected') throw new Error(body.error?.code ?? 'payment_connection_failed');
      setStatus('not_connected');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const tone = status === 'ready' ? 'success' : status === 'pending' ? 'warning' : undefined;
  return <Card>
    <div className="flex items-start justify-between gap-3">
      <div><h2 className="font-semibold">{t('title')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{t('description')}</p></div>
      <CreditCard aria-hidden="true" className="text-[var(--accent-strong)]" size={22}/>
    </div>
    {status
      ? <div className="mt-4 flex min-h-11 items-center justify-between gap-3"><span>{t('status')}</span><Badge tone={tone}>{t(`states.${status}`)}</Badge></div>
      : <div className="mt-4 h-11 animate-pulse rounded-lg bg-[var(--surface-raised)]" aria-label={t('loading')}/>
    }
    {error && <div role="alert" className="mt-3 rounded-lg border border-[var(--danger)] p-3 text-sm text-[var(--danger)]"><p>{t('error')}</p><button type="button" className="mt-2 inline-flex min-h-11 items-center gap-2 font-semibold" onClick={() => void load()}><RotateCcw aria-hidden="true" size={16}/>{t('retry')}</button></div>}
    {status === 'not_connected' && <button type="button" disabled={busy} className={buttonStyles('primary', 'mt-4')} onClick={() => void connect()}>{t('connect')}</button>}
    {(status === 'pending' || status === 'ready') && <div className="mt-4 flex flex-wrap gap-2">
      {status === 'pending' && <button type="button" disabled={busy} className={buttonStyles('primary')} onClick={() => void connect()}>{t('continue')}</button>}
      <button type="button" disabled={busy} className={buttonStyles('secondary')} onClick={() => void disconnect()}>{t('disconnect')}</button>
    </div>}
  </Card>;
}
