import Link from 'next/link';
import {ArrowRight, Languages, PhoneForwarded} from 'lucide-react';
import {getFormatter, getTranslations} from 'next-intl/server';
import {aggregateAnalytics} from '@/lib/analytics';
import {getDataSource} from '@/lib/data';
import type {Call, Language} from '@/lib/data/types';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {Badge, Card, EmptyState, PageHeader, Stat} from '@/components/ui';

const outcomeOrder: Call['outcome'][] = ['answered', 'message', 'booking', 'order', 'transferred'];
const languageOrder: Language[] = ['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar'];

export default async function Page({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  const source = getDataSource();
  const t = await getTranslations('screens.analytics');
  const common = await getTranslations('common');
  const format = await getFormatter();
  const [restaurant, calls, params] = await Promise.all([getCurrentRestaurant(), source.listCalls(), searchParams]);
  const fallback = callDateBounds(calls, restaurant.timezone);
  const from = dateParam(params.from) ?? fallback.from;
  const to = dateParam(params.to) ?? fallback.to;
  const range = from <= to ? {from, to} : fallback;
  const analytics = aggregateAnalytics(calls, range, restaurant.timezone);
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')}/>;

  return <>
    {header}
    <Card className="mb-4">
      <form method="get" className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <h2 className="font-semibold sm:col-span-3">{t('dateRange')}</h2>
        <DateField name="from" label={t('from')} value={range.from}/>
        <DateField name="to" label={t('to')} value={range.to}/>
        <button className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]" type="submit">{t('apply')}</button>
      </form>
    </Card>
    {!analytics.totalCalls ? <EmptyState message={t('empty')} action={t('action')} href="/calls"/> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('calls')} value={analytics.totalCalls}/>
        <Stat label={t('minutes')} value={format.number(analytics.totalMinutes, {maximumFractionDigits: 1})}/>
        <Stat label={t('cost')} value={format.number(analytics.totalCostMicros / 1_000_000, {style: 'currency', currency: 'CAD'})}/>
        <Card><div className="flex items-start justify-between gap-2"><div><p className="text-sm text-[var(--muted)]">{t('transfers')}</p><p className="mt-2 text-3xl font-semibold tracking-tight">{format.number(analytics.transfers.rate, {style: 'percent', maximumFractionDigits: 0})}</p></div><PhoneForwarded aria-hidden="true" className="text-[var(--accent-strong)]" size={22}/></div><p className="mt-2 text-xs text-[var(--muted)]">{analytics.transfers.attempts ? `${t('successful', {count: analytics.transfers.successful})} · ${t('attempts', {count: analytics.transfers.attempts})}` : t('noAttempts')}</p></Card>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="font-semibold">{t('outcomes')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{t('outcomesHelp')}</p>
          <ul className="mt-5 space-y-4">
            {outcomeOrder.map((outcome) => <li key={outcome}><Bar label={t(`outcomeLabels.${outcome}`)} value={analytics.outcomes[outcome]} max={analytics.totalCalls}/></li>) }
          </ul>
        </Card>
        <Card>
          <div className="flex items-start justify-between gap-2"><div><h2 className="font-semibold">{t('languageMix')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{t('languageHelp')}</p></div><Languages aria-hidden="true" className="text-[var(--accent-strong)]" size={22}/></div>
          <ul className="mt-5 space-y-4">
            {languageOrder.map((language) => <li key={language}><Bar label={common(`languages.${language}`)} value={analytics.languages[language]} max={analytics.totalCalls}/></li>) }
          </ul>
        </Card>
      </div>
      <Card className="mt-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">{t('busiest')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{t('busiestHelp', {timezone: restaurant.timezone})}</p></div><Badge>{range.from} <ArrowRight aria-hidden="true" className="mx-1" size={13}/> {range.to}</Badge></div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] border-separate border-spacing-1 text-center text-xs">
            <caption className="sr-only">{t('heatmapCaption')}</caption>
            <thead><tr><th scope="col" className="p-1 text-left text-[var(--muted)]">{t('hour')}</th>{Array.from({length: 24}, (_, hour) => <th key={hour} scope="col" className="p-1 font-medium text-[var(--muted)]">{hour}</th>)}</tr></thead>
            <tbody>{analytics.busiestHours.map((hours, day) => <tr key={day}><th scope="row" className="p-1 text-left font-medium">{t(`weekdays.${day}`)}</th>{hours.map((count, hour) => <td key={hour} className="h-7 min-w-6 rounded border p-1 tabular-nums" style={{background: heatColour(count, analytics.busiestHours)}}>{count}</td>)}</tr>)}</tbody>
          </table>
        </div>
      </Card>
      <Link href="/calls" className="mt-4 inline-flex min-h-11 items-center font-semibold text-[var(--accent-strong)]">{t('action')}<ArrowRight aria-hidden="true" className="ml-2" size={18}/></Link>
    </>}
  </>;
}

function DateField({name, label, value}: {name: string; label: string; value: string}) {
  return <label className="text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{label}</span><input type="date" name={name} defaultValue={value} required className="min-h-11 w-full rounded-lg border bg-[var(--background)] px-3"/></label>;
}

function Bar({label, value, max}: {label: string; value: number; max: number}) {
  const width = max ? Math.max(value ? 4 : 0, (value / max) * 100) : 0;
  return <div><div className="mb-1 flex justify-between gap-3 text-sm"><span>{label}</span><strong className="tabular-nums">{value}</strong></div><div className="h-2 overflow-hidden rounded-full bg-[var(--surface-raised)]"><div className="h-full rounded-full bg-[var(--accent)]" style={{width: `${width}%`}}/></div></div>;
}

function dateParam(value: string | string[] | undefined): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : null;
}

function callDateBounds(calls: Call[], timeZone: string): {from: string; to: string} {
  const formatter = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
  const dates = calls.map((call) => {
    const parts = formatter.formatToParts(new Date(call.startedAt));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  }).sort();
  return {from: dates[0] ?? '2026-10-27', to: dates.at(-1) ?? '2026-10-27'};
}

function heatColour(value: number, matrix: number[][]): string {
  const max = Math.max(1, ...matrix.flat());
  const opacity = value === 0 ? 0 : 12 + Math.round((value / max) * 23);
  return value === 0 ? 'var(--surface-raised)' : `color-mix(in srgb, var(--accent) ${opacity}%, var(--surface))`;
}
