'use client';

import {ExternalLink, Scale} from 'lucide-react';
import {useTranslations} from 'next-intl';
import {useState} from 'react';
import type {LegalSettings, NotificationPreferences} from '@/lib/data/types';
import type {CanadianProvince} from '@/lib/data/types';
import {recordingLanguageOrder} from '@/lib/compliance/recording';
import {validateRetentionDays, validateSpendCap} from '@/lib/settings';
import {Badge, Card, Switch, buttonStyles, inputBase} from '@/components/ui';
import {PrivacyRequestForm} from '@/components/privacy-request-form';
import {saveLegalSettings, saveNotificationPreferences} from './actions';

export function SettingsControls({notifications, spendCapCents, legal, restaurantId, province, canManagePrivacy}: {notifications: NotificationPreferences; spendCapCents: number; legal: LegalSettings; restaurantId: string; province: CanadianProvince; canManagePrivacy: boolean}) {
  const t = useTranslations('screens.settings');
  const [preferences, setPreferences] = useState(notifications);
  const [spendCap, setSpendCap] = useState((spendCapCents / 100).toFixed(2));
  const [recordingRetentionDays, setRecordingRetentionDays] = useState(String(legal.recordingRetentionDays ?? 90));
  const [transcriptRetentionDays, setTranscriptRetentionDays] = useState(String(legal.transcriptRetentionDays ?? 365));
  const spendCapResult = validateSpendCap(spendCap);
  const recommendedNotice = recordingLanguageOrder(province).map((language) => t(`recordingCopy.${language}`)).join('\n\n');
  const initialNotice = legal.recordingNotice.trim() || recommendedNotice;

  return <>
    <Card>
      <h2 className="font-semibold">{t('notifications')}</h2>
      <form action={saveNotificationPreferences} className="mt-3 space-y-1">
        {(['messageTaken', 'missedTransfer', 'flaggedCall', 'lowBalance', 'dailyDigest'] as const).map((key) => <div key={key} className="rounded-[var(--radius-control)] px-2 hover:bg-[var(--surface-raised)]"><Switch label={t(key)} name={key} checked={preferences[key]} onChange={(event) => setPreferences((current) => ({...current, [key]: event.target.checked}))}/></div>)}
        <button className={buttonStyles('primary', 'mt-3')}>{t('saveNotifications')}</button>
      </form>
      <label className="mt-5 block text-sm font-medium"><span>{t('spendCap')}</span><div className="relative mt-1"><span aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]">$</span><input value={spendCap} onChange={(event) => setSpendCap(event.target.value)} inputMode="decimal" aria-invalid={!spendCapResult.valid} aria-describedby="spend-cap-help" className={`${inputBase} pl-7`}/></div></label>
      <p id="spend-cap-help" className={`mt-2 text-xs ${spendCapResult.valid ? 'text-[var(--muted)]' : 'text-[var(--danger)]'}`}>{spendCapResult.valid ? t('spendCapHelp') : t('spendCapError')}</p>
    </Card>
    <Card>
      <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{t('legal')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{t('recording')}</p></div><Scale aria-hidden="true" className="text-[var(--accent-strong)]" size={22}/></div>
      {legal.legalReviewRequired && <div className="mt-4"><Badge tone="warning">{t('legalReview')}</Badge></div>}
      <p className="mt-4 text-sm font-semibold">{t('recordingRecommended')}</p>
      <div className="mt-2 space-y-2">{recordingLanguageOrder(province).map((language) => <p key={language} lang={language === 'fr' ? 'fr-CA' : 'en-CA'} className="rounded-lg bg-[var(--surface-raised)] p-3 text-sm">{t(`recordingCopy.${language}`)}</p>)}</div>
      <form action={saveLegalSettings} className="mt-4 grid gap-3">
        <input type="hidden" name="province" value={province}/>
        <label className="block"><span className="sr-only">{t('recording')}</span><textarea name="recordingNotice" defaultValue={initialNotice} rows={5} className="w-full rounded-lg border bg-[var(--background)] p-3"/></label>
        <label className="flex min-h-12 items-center justify-between gap-4"><span>{t('recordingEnabled')}</span><input type="checkbox" name="recordingEnabled" defaultChecked={legal.recordingEnabled} className="size-5 accent-[var(--accent)]"/></label>
        <label className="flex min-h-12 items-center justify-between gap-4"><span>{t('transcriptEnabled')}</span><input type="checkbox" name="transcriptEnabled" defaultChecked={legal.transcriptEnabled} className="size-5 accent-[var(--accent)]"/></label>
        <label className="grid gap-1 text-sm font-medium">{t('recordingRetentionDays')}<input required type="number" min="30" max="365" step="1" name="recordingRetentionDays" value={recordingRetentionDays} onChange={(event) => setRecordingRetentionDays(event.target.value)} aria-invalid={!validateRetentionDays(recordingRetentionDays).valid} className={inputBase}/></label>
        <label className="grid gap-1 text-sm font-medium">{t('transcriptRetentionDays')}<input required type="number" min="30" max="365" step="1" name="transcriptRetentionDays" value={transcriptRetentionDays} onChange={(event) => setTranscriptRetentionDays(event.target.value)} aria-invalid={!validateRetentionDays(transcriptRetentionDays).valid} className={inputBase}/></label>
        <p className="text-sm text-[var(--muted)]">{t('retentionHelp')}</p>
        <p className="text-sm text-[var(--muted)]">{t('recordingControlsHelp')}</p>
        <button disabled={!validateRetentionDays(recordingRetentionDays).valid || !validateRetentionDays(transcriptRetentionDays).valid} className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)] disabled:opacity-60">{t('saveRecordingNotice')}</button>
      </form>
      <a href={legal.privacyPolicyUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-11 items-center font-semibold text-[var(--accent-strong)]">{t('privacy')}<ExternalLink aria-hidden="true" className="ml-2" size={16}/></a>
      <PrivacyRequestForm restaurantId={restaurantId} province={province} canManage={canManagePrivacy}/>
    </Card>
  </>;
}
