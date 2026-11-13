'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
import {ArrowRight, RotateCcw, Sparkles} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {z} from 'zod';

import type {OnboardingState, SaveOnboardingStateInput} from '@/lib/data/types';
import {Badge, Card} from './ui';

type RequestFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const importResponseSchema = z.object({
  id: z.string(),
  status: z.enum(['processing', 'completed', 'failed']),
  reviewRowCount: z.number().int().nonnegative().optional(),
  reviewCounts: z.object({
    menu: z.number().int().nonnegative(),
    hours: z.number().int().nonnegative(),
    faqs: z.number().int().nonnegative(),
  }).optional(),
  partial: z.boolean().optional(),
  incompleteMenu: z.boolean().optional(),
});
const errorResponseSchema = z.object({error: z.object({code: z.string()})});

type ImportResponse = z.infer<typeof importResponseSchema>;

class ImportRequestError extends Error {
  constructor(readonly code: string) { super(code); }
}

const primaryButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border bg-[var(--surface)] px-4 font-semibold disabled:cursor-not-allowed disabled:opacity-50';
const inputClass = 'min-h-11 w-full rounded-lg border bg-[var(--background)] px-3 text-[15px] text-[var(--text)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-soft)]';

async function parseResponse(response: Response): Promise<ImportResponse> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(body);
    throw new ImportRequestError(parsed.success ? parsed.data.error.code : 'UNKNOWN');
  }
  return importResponseSchema.parse(body);
}

export function WebsiteImportFlow({restaurantId, basics, saveStep, request = fetch}: {
  restaurantId: string;
  basics: OnboardingState['basics'];
  saveStep: (payload: SaveOnboardingStateInput) => Promise<void>;
  request?: RequestFn;
}) {
  const t = useTranslations('screens.onboarding');
  const [url, setUrl] = useState(basics.websiteUrl);
  const [job, setJob] = useState<ImportResponse | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [menuFile, setMenuFile] = useState<File | null>(null);
  const mounted = useRef(true);
  const errorMessage = useCallback((cause: unknown) => cause instanceof ImportRequestError
    ? t(`import.errorCodes.${['PROVIDER_ERROR', 'SCHEMA_MISMATCH', 'RATE_LIMITED', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND'].includes(cause.code) ? cause.code : 'UNKNOWN'}`)
    : t('errors.import'), [t]);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!job || job.status !== 'processing') return;
    const timer = window.setTimeout(async () => {
      try {
        const next = await parseResponse(await request(`/api/import/${encodeURIComponent(job.id)}`));
        if (!mounted.current) return;
        setJob(next);
        setProgress(next.status === 'completed' ? 100 : next.status === 'failed' ? 70 : 60);
        if (next.status === 'failed') setError(t('import.failed'));
      } catch (cause) {
        if (mounted.current) setError(errorMessage(cause));
      }
    }, 600);
    return () => window.clearTimeout(timer);
  }, [errorMessage, job, request, t]);

  const start = async () => {
    setBusy(true);
    setError('');
    try {
      if (!/^https?:\/\//u.test(url)) throw new Error(t('errors.website'));
      const next = await parseResponse(await request('/api/import', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({restaurantId, url}),
      }));
      setJob(next);
      setProgress(next.status === 'completed' ? 100 : 30);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const continueWithUrl = async () => {
    setBusy(true);
    setError('');
    try {
      await saveStep({basics: {...basics, websiteUrl: url}, importJobId: job?.id ?? null, completedStep: 2});
    } catch {
      setError(t('errors.save'));
    } finally {
      setBusy(false);
    }
  };

  const uploadMenu = async () => {
    if (!menuFile) return;
    setBusy(true);
    setError('');
    try {
      const body = new FormData();
      body.set('restaurantId', restaurantId);
      body.set('menuFile', menuFile);
      const next = await parseResponse(await request('/api/import/file', {method: 'POST', body}));
      setJob(next);
      setProgress(100);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const missingSections = job?.reviewCounts
    ? (['menu', 'hours', 'faqs'] as const)
      .filter((key) => job.reviewCounts?.[key] === 0)
      .map((key) => t(`import.sections.${key}`))
    : [];
  if (job?.incompleteMenu) missingSections.unshift(t('import.sections.menuDetails'));
  const needsMenuFallback = Boolean(error || job?.reviewCounts?.menu === 0 || job?.incompleteMenu);

  return <div className="space-y-4">
    {error && <div role="alert" className="rounded-lg border border-[var(--danger)] p-3 text-[var(--danger)]">{error}</div>}
    {job?.status === 'completed' && job.partial && <div role="alert" className="rounded-lg border border-[var(--warning)] p-3 text-[var(--warning)]">{t('import.partial', {sections: missingSections.join(', ')})}</div>}
    <Card>
      <form aria-label={t('steps.2.formLabel')} onSubmit={(event) => { event.preventDefault(); void start(); }} className="space-y-4">
        <label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{t('basics.website')}</span><input className={inputClass} name="websiteUrl" type="url" value={url} onChange={(event) => setUrl(event.target.value)} required/></label>
        <button className={primaryButton} disabled={busy || job?.status === 'processing'}><Sparkles aria-hidden="true" size={18}/>{t('import.start')}</button>
      </form>
    </Card>
    {job && <Card>
      <div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{t(`import.apiStatuses.${job.status}`)}</h2><Badge tone={job.status === 'completed' ? 'success' : 'warning'}>{progress}%</Badge></div>
      <div className="mt-4 h-3 overflow-hidden rounded-full bg-[var(--surface-raised)]"><div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{width: `${progress}%`}}/></div>
      <div role="progressbar" aria-label={t('import.progress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}/>
    </Card>}
    {needsMenuFallback && <Card>
      <form aria-label={t('import.uploadForm')} onSubmit={(event) => { event.preventDefault(); void uploadMenu(); }} className="space-y-3">
        <label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{t('import.uploadLabel')}</span><input className={inputClass} name="menuFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(event) => setMenuFile(event.target.files?.[0] ?? null)} required/></label>
        <p className="text-sm text-[var(--muted)]">{t('import.uploadHelp')}</p>
        <button className={primaryButton} disabled={busy || !menuFile}>{t('import.upload')}</button>
      </form>
    </Card>}
    <div className="flex flex-wrap gap-2">
      {error && <button type="button" className={secondaryButton} onClick={() => void start()} disabled={busy}><RotateCcw aria-hidden="true" size={17}/>{t('import.retry')}</button>}
      <button type="button" className={secondaryButton} onClick={() => void continueWithUrl()} disabled={busy}>{t('import.manual')}</button>
      {job?.status === 'completed' && <button type="button" className={primaryButton} onClick={() => void continueWithUrl()} disabled={busy}>{t('continue')}<ArrowRight aria-hidden="true" size={18}/></button>}
    </div>
  </div>;
}
