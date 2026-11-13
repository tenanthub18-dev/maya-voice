import Link from 'next/link';
import {CalendarDays, ChevronLeft, Clock3, PackageCheck, Volume2} from 'lucide-react';
import {getFormatter, getTranslations} from 'next-intl/server';
import {TeachDrawer} from '@/components/teach-drawer';
import {Badge, Card, EmptyState, LatencyStrip, PageHeader, TranscriptBubble} from '@/components/ui';
import {calculateLatencySummary, callCallerLabel, formatDuration, getCallDurationSeconds, getCallUsageSummary} from '@/lib/calls';
import {getDataSource} from '@/lib/data';
import {stripBidiControls} from '@/lib/security/text';

export default async function CallDetailPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const source = getDataSource();
  const t = await getTranslations('screens.callDetail');
  const common = await getTranslations('common');
  const reporting = await getTranslations('callReporting');
  const format = await getFormatter();
  const [calls, restaurant] = await Promise.all([source.listCalls(), source.getRestaurant()]);
  const call = calls.find((row) => row.id === id);
  if (!call) return <EmptyState message={t('empty')} action={t('back')} href="/calls"/>;

  const [turns, metrics, bookings, orders] = await Promise.all([
    source.listCallTurns(call.id), source.listCallMetrics(call.id), source.listBookings(), source.listOrders()
  ]);
  const booking = bookings.find((row) => row.callId === call.id);
  const order = orders.find((row) => row.callId === call.id);
  const latency = calculateLatencySummary(metrics);
  const usage = getCallUsageSummary(call);
  const usageFields = ['total_tokens', 'prompt_tokens', 'completion_tokens', 'cache_read_input_tokens', 'audio_seconds', 'characters', 'generated_audio_seconds'] as const;
  const cost = (micros: number | null) => micros === null ? reporting('unavailable') : reporting('usd', {amount: format.number(micros / 1_000_000, {minimumFractionDigits: 4, maximumFractionDigits: 4})});
  const costBases = new Set(['reported_text_tokens', 'estimated_audio_only_excludes_stt_text', 'estimated_text_and_audio', 'estimated_text_only']);
  const teachLabels = {open: t('teach'), title: t('teachTitle'), description: t('teachDescription'), field: t('teachField'), save: t('save'), saving: t('saving'), cancel: t('cancel'), close: t('close')};

  return <>
    <Link href="/calls" className="mb-4 inline-flex min-h-11 items-center gap-2 font-semibold text-[var(--accent-strong)]"><ChevronLeft aria-hidden="true" size={18}/>{t('back')}</Link>
    <PageHeader eyebrow={t('eyebrow')} title={t('title', {caller: callCallerLabel(call, reporting('browserCaller'))})} description={format.dateTime(new Date(call.startedAt), {dateStyle: 'long', timeStyle: 'short', timeZone: restaurant.timezone})}/>
    <div className="grid gap-4 md:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[280px_minmax(0,1fr)]">
      <div className="hidden md:block"><Card className="sticky top-6 p-2"><nav aria-label={t('back')} className="divide-y">{calls.slice(0, 8).map((row) => <Link key={row.id} href={`/calls/${row.id}`} aria-current={row.id === call.id ? 'page' : undefined} className={`block rounded-[var(--radius-control)] px-3 py-3 ${row.id === call.id ? 'bg-[var(--color-accent-soft)] text-[var(--color-accent)]' : 'hover:bg-[var(--color-surface-raised)]'}`}><strong className="block text-sm">{callCallerLabel(row, reporting('browserCaller'))}</strong><span className="mt-1 block text-xs text-[var(--color-text-muted)]">{format.dateTime(new Date(row.startedAt), {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: restaurant.timezone})}</span></Link>)}</nav></Card></div>
      <div className="min-w-0">
    <div className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
      <Card><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-sm font-semibold text-[var(--muted)]">{t('summary')}</p><p className="mt-2 text-lg">{stripBidiControls(call.summary || (call.source === 'browser' ? reporting('browserSummary') : ''))}</p></div><Badge tone={call.outcome === 'transferred' ? 'warning' : 'success'}>{t(`outcomes.${call.outcome}`)}</Badge></div><div className="mt-4 flex flex-wrap gap-2">{call.languages.map((language) => <Badge key={language}>{common(`languages.${language}`)}</Badge>)}<Badge>{formatDuration(getCallDurationSeconds(call))}</Badge>{call.qaFlags.map((flag) => <Badge key={flag} tone="warning">{t('flagged')}</Badge>)}</div></Card>
      <Card><div className="flex items-center gap-2"><Volume2 aria-hidden="true" className="text-[var(--accent-strong)]" size={20}/><h2 className="font-semibold">{t('recording')}</h2></div>{call.recordingPath ? <figure className="mt-4"><audio className="w-full" controls preload="metadata" src={`/api/calls/${encodeURIComponent(call.id)}/recording`}/><figcaption className="mt-2 text-sm text-[var(--muted)]">{t('recordingCaption')}</figcaption></figure> : <div className="mt-4 rounded-lg bg-[var(--surface-raised)] p-4"><p className="font-medium">{t('noRecording')}</p><p className="mt-1 text-sm text-[var(--muted)]">{call.source === 'browser' ? reporting('noRecordingNote') : t('noRecordingNote')}</p></div>}</Card>
    </div>

    <Card className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{reporting('title')}</h2><Badge tone={usage.status === 'partial' ? 'warning' : 'neutral'}>{reporting(usage.status)}</Badge></div>
      {usage.incomplete && <p className="mt-2 text-sm text-[var(--warning)]">{reporting('incomplete')}</p>}
      <p className="mt-3 font-semibold tabular-nums">{cost(usage.costMicros)}</p>
      {usage.costMicros !== null && <p className="mt-1 text-sm text-[var(--muted)]">{reporting(usage.status === 'partial' ? 'partialNote' : 'estimateNote')}</p>}
      {usage.totals && <><dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{usageFields.map((key) => <div key={key}><dt className="text-sm text-[var(--muted)]">{reporting(key)}</dt><dd className="font-medium tabular-nums">{usage.totals![key] == null ? reporting('unavailable') : format.number(usage.totals![key]!)}</dd></div>)}</dl><p className="mt-3 text-xs text-[var(--muted)]">{reporting('cachedNote')}</p></>}
      {usage.services.length > 0 && <div className="mt-4"><h3 className="text-sm font-semibold">{reporting('services')}</h3><ul className="mt-2 divide-y">{usage.services.map((service, index) => <li key={index} className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm"><div className="min-w-0"><p className="break-words">{reporting(`kinds.${service.kind}`)} · {service.model ? stripBidiControls(service.model) : reporting('modelUnavailable')}</p><p className="mt-1 text-xs text-[var(--muted)]">{reporting(`basis.${costBases.has(service.cost_basis) ? service.cost_basis : 'unavailable'}`)}</p></div><p className="tabular-nums">{cost(service.cost_micros)}</p></li>)}</ul></div>}
      {usage.rateAsOf && <p className="mt-3 text-xs text-[var(--muted)]">{reporting('ratesAsOf', {date: stripBidiControls(usage.rateAsOf)})}</p>}
    </Card>

    <Card className="mt-4"><div className="mb-4 flex items-center gap-2"><Clock3 aria-hidden="true" className="text-[var(--accent-strong)]" size={20}/><div><h2 className="font-semibold">{t('latency')}</h2><p className="text-sm text-[var(--muted)]">{t('budget')}</p></div></div>{metrics.length ? <LatencyStrip stages={latency.map((stage) => ({key: stage.key, label: t(`latencyStages.${stage.key}`), p50Label: t('p50'), p95Label: t('p95'), p50: stage.p50 === null ? t('unavailable') : t('milliseconds', {value: stage.p50}), p95: stage.p95 === null ? t('unavailable') : t('milliseconds', {value: stage.p95}), status: stage.key === 'total' && stage.p95WithinBudget === false ? 'warning' as const : 'good' as const}))}/> : <p className="text-[var(--muted)]">{t('noMetrics')}</p>}</Card>

    {(booking || order) && <Card className="mt-4"><h2 className="font-semibold">{t('linked')}</h2><div className="mt-3 grid gap-3 sm:grid-cols-2">{booking && <div className="flex gap-3 rounded-lg bg-[var(--surface-raised)] p-4"><CalendarDays aria-hidden="true" className="shrink-0 text-[var(--accent-strong)]"/><div><p className="font-semibold">{t('booking')}</p><p className="mt-1 text-sm text-[var(--muted)]">{t('bookingDetails', {party: booking.partySize, date: format.dateTime(new Date(booking.startsAt), {dateStyle: 'medium', timeStyle: 'short', timeZone: restaurant.timezone})})}</p></div></div>}{order && <div className="flex gap-3 rounded-lg bg-[var(--surface-raised)] p-4"><PackageCheck aria-hidden="true" className="shrink-0 text-[var(--accent-strong)]"/><div><p className="font-semibold">{t('order')}</p><p className="mt-1 text-sm text-[var(--muted)]">{t('orderDetails', {amount: format.number(order.totalCents / 100, {style: 'currency', currency: 'CAD'}), time: format.dateTime(new Date(order.pickupAt), {timeStyle: 'short', timeZone: restaurant.timezone})})}</p></div></div>}</div></Card>}

    <Card className="mt-4"><div className="mb-4"><h2 className="font-semibold">{t('transcript')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{t('transcriptNote')}</p></div>{turns.length ? <ol className="space-y-3">{turns.map((turn) => { const safeText = stripBidiControls(turn.text); return <li key={turn.id}><TranscriptBubble speaker={turn.speaker} meta={<><span>{t(turn.speaker)} · {common(`languages.${turn.language}`)}</span><time>{formatDuration(Math.floor(turn.startedMs / 1000))}</time></>} action={turn.speaker === 'agent' ? <TeachDrawer callId={call.id} question={safeText} language={turn.language} labels={teachLabels}/> : undefined}><p>{safeText}</p></TranscriptBubble></li>; })}</ol> : <p className="text-[var(--muted)]">{t('noTranscript')}</p>}</Card>
      </div>
    </div>
  </>;
}
