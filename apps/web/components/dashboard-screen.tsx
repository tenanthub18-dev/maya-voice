import Link from 'next/link';
import {AlertTriangle, CheckCircle2, PhoneCall, Radio, SlidersHorizontal} from 'lucide-react';
import {getFormatter, getTranslations} from 'next-intl/server';
import {AgentToggle} from './agent-toggle';
import {OperationalBanners, type OperationalNotice} from './operational-banners';
import {evaluateSpendCap} from '@/lib/billing/spend-cap';
import {applyCallFilters, callCallerLabel, formatDuration, getCallDurationSeconds, getCallUsageSummary, parseCallFilters} from '@/lib/calls';
import {buildHomeStats, groupOrdersByStatus} from '@/lib/dashboard';
import {getDataSource} from '@/lib/data';
import {getOperationalStatus} from '@/lib/operations/status';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {Badge, Card, EmptyState, PageHeader, Select, Stat} from './ui';

export type Screen = 'bookings' | 'orders' | 'agent' | 'phone' | 'analytics' | 'settings';

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export async function HomeScreen() {
  const source = getDataSource();
  const t = await getTranslations('screens.home');
  const reporting = await getTranslations('callReporting');
  const operational = await getTranslations('operational');
  const common = await getTranslations('common');
  const [restaurant, calls, bookings, orders, messages, agent, activeCall, organization, usage, phone] = await Promise.all([
    getCurrentRestaurant(), source.listCalls(), source.listBookings(), source.listOrders(), source.listMessages(), source.getAgent(), source.getActiveCall(), source.getOrganization(), source.getUsage(), source.getPhoneNumber()
  ]);
  const spendAllowed = organization ? evaluateSpendCap({currentCostMicros: usage.costMicros, projectedCallCostMicros: 0, spendCapCents: organization.spendCapCents}).allowed : true;
  const operationalStatus = getOperationalStatus({
    now: new Date(), timeZone: restaurant.timezone, transferHours: restaurant.transferHours,
    restaurantPaused: restaurant.status === 'paused', agentEnabled: agent.enabled, spendAllowed,
    lastInvoiceStatus: organization?.lastInvoiceStatus,
    stripeInvoiceEventCreatedAt: organization?.stripeInvoiceEventCreatedAt,
  });
  const notices: OperationalNotice[] = [];
  if (operationalStatus.agentPaused) notices.push({id: 'paused', tone: 'danger', title: operational('pausedTitle'), body: operational('pausedBody')});
  if (operationalStatus.spendBlocked) notices.push({id: 'spend', tone: 'danger', title: operational('spendTitle'), body: operational('spendBody')});
  if (operationalStatus.paymentGrace) notices.push({id: 'payment-grace', tone: 'warning', title: operational('graceTitle'), body: operational('graceBody')});
  if (operationalStatus.paymentBlocked) notices.push({id: 'payment-blocked', tone: 'danger', title: operational('paymentBlockedTitle'), body: operational('paymentBlockedBody')});
  if (operationalStatus.transferClosed) notices.push({id: 'transfer-closed', tone: 'warning', title: operational('transferClosedTitle'), body: operational('transferClosedBody')});
  if (phone?.status === 'active' && phone.forwardingVerifiedAt === null) notices.push({id: 'forwarding-unverified', tone: 'danger', title: operational('forwardingTitle'), body: operational('forwardingBody')});
  if (phone?.status === 'released') notices.push({id: 'number-released', tone: 'danger', title: operational('releasedTitle'), body: operational('releasedBody')});
  const today = dateKey(new Date(), restaurant.timezone);
  const stats = buildHomeStats(calls, bookings, orders, messages, today);
  const flags = calls.filter((call) => call.qaFlags.length);
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title', {restaurant: restaurant.name})} description={t('description')} />;

  if (!calls.length) return <>{header}<OperationalBanners notices={notices}/><AgentToggle enabled={agent.enabled} label={t('agentSwitch')} onLabel={t('agentOn')} offLabel={t('agentOff')} savingLabel={t('saving')}/><div className="mt-4"><EmptyState message={t('empty')} action={t('action')} href="/phone" /></div></>;

  return <>
    {header}
    <OperationalBanners notices={notices}/>
    {activeCall && <div className="mb-4 flex min-h-16 items-center gap-3 rounded-[var(--radius-panel)] border border-[var(--success)] bg-[var(--surface)] px-4" role="status"><span className="relative flex size-3 shrink-0"><span className="motion-live-pulse absolute inline-flex size-full rounded-full bg-[var(--success)] opacity-50"/><span className="relative inline-flex size-3 rounded-full bg-[var(--success)]"/></span><div className="min-w-0 flex-1"><strong>{t('live')}</strong><p className="text-sm text-[var(--muted)]">{common(`languages.${activeCall.language}`)} · {formatDuration(activeCall.durationSeconds)}</p></div><Radio aria-hidden="true" className="text-[var(--success)]" size={20}/></div>}
    <AgentToggle enabled={agent.enabled} label={t('agentSwitch')} onLabel={t('agentOn')} offLabel={t('agentOff')} savingLabel={t('saving')}/>
    <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4"><Stat label={t('calls')} value={stats.calls}/><Stat label={t('bookings')} value={stats.bookings}/><Stat label={t('orders')} value={stats.orders}/><Stat label={t('messages')} value={stats.messages}/></div>
    <Card className="mt-4"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">{t('issues')}</h2><Badge tone={flags.length ? 'warning' : 'success'}>{flags.length}</Badge></div>{flags.length ? <ul className="mt-3 divide-y">{flags.slice(0, 5).map((call) => <li key={call.id}><Link href={`/calls/${call.id}`} className="flex min-h-14 items-center gap-3 py-2"><AlertTriangle aria-hidden="true" className="shrink-0 text-[var(--warning)]" size={18}/><span className="min-w-0 flex-1"><span className="block font-medium">{t('flaggedCall', {caller: callCallerLabel(call, reporting('browserCaller'))})}</span><span className="block truncate text-sm text-[var(--muted)]">{call.summary}</span></span><span className="text-sm font-semibold text-[var(--accent-strong)]">{t('review')}</span></Link></li>)}</ul> : <div className="mt-3 flex min-h-14 items-center gap-2 text-[var(--muted)]"><CheckCircle2 aria-hidden="true" className="text-[var(--success)]" size={18}/>{t('noIssues')}</div>}</Card>
  </>;
}

export async function CallsScreen({searchParams}: {searchParams: Record<string, string | string[] | undefined>}) {
  const source = getDataSource();
  const t = await getTranslations('screens.calls');
  const reporting = await getTranslations('callReporting');
  const common = await getTranslations('common');
  const format = await getFormatter();
  const [restaurant, allCalls] = await Promise.all([getCurrentRestaurant(), source.listCalls()]);
  const filters = parseCallFilters(searchParams);
  const calls = applyCallFilters(allCalls, filters, dateKey(new Date(), restaurant.timezone), restaurant.timezone);
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />;
  return <>
    {header}
    <Card className="mb-4">
      <div className="mb-3 flex items-center gap-2 font-semibold"><SlidersHorizontal aria-hidden="true" size={18}/><h2>{t('filters')}</h2></div>
      <form method="get" className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_auto_auto] lg:items-end">
        <FilterSelect name="date" label={t('date')} value={filters.date} options={[['all', t('allDates')], ['today', t('today')], ['7d', t('last7')], ['30d', t('last30')]]}/>
        <FilterSelect name="outcome" label={t('outcome')} value={filters.outcome} options={[['all', t('allOutcomes')], ...(['booking', 'order', 'message', 'answered', 'transferred'] as const).map((key) => [key, t(`outcomes.${key}`)] as [string, string])]}/>
        <FilterSelect name="language" label={t('language')} value={filters.language} options={[['all', t('allLanguages')], ...(['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar'] as const).map((key) => [key, common(`languages.${key}`)] as [string, string])]}/>
        <label className="flex min-h-11 items-center gap-2 rounded-lg border px-3"><input type="checkbox" name="flagged" value="true" defaultChecked={filters.flagged} className="size-5 accent-[var(--accent)]"/><span className="text-sm font-medium">{t('flaggedOnly')}</span></label>
        <button type="submit" className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{t('apply')}</button>
      </form>
      {(filters.date !== 'all' || filters.outcome !== 'all' || filters.language !== 'all' || filters.flagged) && <Link href="/calls" className="mt-3 inline-flex min-h-11 items-center text-sm font-semibold text-[var(--accent-strong)]">{t('clear')}</Link>}
    </Card>
    {!calls.length ? <EmptyState message={t('empty')} action={t('action')} href="/calls"/> : <Card><div className="mb-2 flex items-center justify-between gap-3"><h2 className="font-semibold">{t('results')}</h2><Badge>{calls.length}</Badge></div><div className="divide-y">{calls.map((call) => { const usage = getCallUsageSummary(call); return <Link key={call.id} href={`/calls/${call.id}`} className="grid min-h-[76px] grid-cols-[1fr_auto] items-center gap-3 py-3"><div className="min-w-0"><p className="font-medium">{callCallerLabel(call, reporting('browserCaller'))}</p><p className="mt-1 text-sm text-[var(--muted)]">{format.dateTime(new Date(call.startedAt), {dateStyle: 'medium', timeStyle: 'short', timeZone: restaurant.timezone})}</p><p className="mt-1 text-xs text-[var(--muted)]">{!usage.totals && usage.costMicros === null ? reporting('usageUnavailable') : <>{usage.totals?.total_tokens != null ? reporting('compactTokens', {value: format.number(usage.totals.total_tokens)}) : reporting('unavailable')} · {usage.costMicros === null ? reporting('unavailable') : <>{reporting(usage.status)} {reporting('usd', {amount: format.number(usage.costMicros / 1_000_000, {minimumFractionDigits: 4, maximumFractionDigits: 4})})}</>}</>}</p><div className="mt-2 flex flex-wrap gap-1">{call.languages.map((language) => <Badge key={language}>{common(`languages.${language}`)}</Badge>)}{call.qaFlags.length > 0 && <Badge tone="warning">{t('flagged')}</Badge>}</div></div><div className="text-right"><Badge tone={call.outcome === 'transferred' ? 'warning' : 'success'}>{t(`outcomes.${call.outcome}`)}</Badge><p className="mt-2 text-sm tabular-nums text-[var(--muted)]">{formatDuration(getCallDurationSeconds(call))}</p></div></Link>; })}</div></Card>}
  </>;
}

function FilterSelect({name, label, value, options}: {name: string; label: string; value: string; options: Array<[string, string]>}) {
  return <Select name={name} label={label} defaultValue={value}><option value="" disabled>{label}</option>{options.map(([optionValue, optionLabel]) => <option key={optionValue} value={optionValue}>{optionLabel}</option>)}</Select>;
}

export async function DashboardScreen({screen}: {screen: Screen}) {
  const source = getDataSource();
  const t = await getTranslations(`screens.${screen}`);
  const common = await getTranslations('common');
  const format = await getFormatter();
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')} />;

  if (screen === 'bookings') {
    const bookings = await source.listBookings();
    if (!bookings.length) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/bookings" /></>;
    const covers = bookings.reduce((sum, booking) => sum + booking.partySize, 0);
    return <>{header}<Card className="mb-4"><div className="flex items-center justify-between"><span>{t('capacity')}</span><strong>{covers}</strong></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--surface-raised)]"><div className="h-full w-2/3 rounded-full bg-[var(--accent)]"/></div></Card><Card><h2 className="mb-3 font-semibold">{t('upcoming')}</h2><div className="divide-y">{bookings.map((booking) => <div key={booking.id} className="flex min-h-16 items-center justify-between gap-3 py-3"><div><strong>{booking.name}</strong><p className="text-sm text-[var(--muted)]">{format.dateTime(new Date(booking.startsAt), {weekday: 'short', hour: 'numeric', minute: '2-digit'})}</p></div><Badge tone="success">{booking.partySize} {t('party')}</Badge></div>)}</div></Card></>;
  }

  if (screen === 'orders') {
    const orders = await source.listOrders();
    if (!orders.length) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/agent" /></>;
    const groups = groupOrdersByStatus(orders);
    return <>{header}<div className="grid gap-4 lg:grid-cols-3">{(['new', 'in-progress', 'ready'] as const).map((status) => <section key={status}><h2 className="mb-3 flex items-center justify-between font-semibold"><span>{t(status)}</span><Badge>{groups[status].length}</Badge></h2><div className="space-y-3">{groups[status].map((order) => <Card key={order.id}><div className="flex items-start justify-between gap-3"><strong>{order.name}</strong><Badge tone={order.paidStatus === 'paid' ? 'success' : 'warning'}>{common(order.paidStatus)}</Badge></div><p className="mt-3 text-sm text-[var(--muted)]">{t('pickup')} · {format.dateTime(new Date(order.pickupAt), {hour: 'numeric', minute: '2-digit'})}</p><p className="mt-2 font-semibold">{t('total')} {format.number(order.totalCents / 100, {style: 'currency', currency: 'CAD'})}</p></Card>)}</div></section>)}</div></>;
  }

  if (screen === 'agent') {
    const [agent, versions, menu, faqs] = await Promise.all([source.getAgent(), source.listAgentVersions(), source.listMenuItems(), source.listFaqs()]);
    if (!versions.length) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/agent" /></>;
    return <>{header}<div className="mb-4 flex flex-wrap gap-2">{['persona', 'languages', 'knowledge', 'rules', 'versions'].map((key) => <Badge key={key}>{t(key)}</Badge>)}</div><div className="grid gap-4 md:grid-cols-2"><Card><p className="text-sm text-[var(--muted)]">{t('persona')}</p><p className="mt-2 text-2xl font-semibold">{agent.personaName}</p><div className="mt-4"><Badge tone="success">{agent.enabled ? t('enabled') : common('pending')}</Badge></div></Card><Card><p className="text-sm text-[var(--muted)]">{t('knowledge')}</p><p className="mt-2 text-2xl font-semibold">{menu.length + faqs.length}</p></Card></div><Card className="sticky bottom-24 mt-4 flex items-center justify-between gap-3 md:bottom-4"><strong>{t('draft')}</strong><div className="flex gap-2"><button className="min-h-11 rounded-lg border px-4 font-semibold">{t('test')}</button><button className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{t('publish')}</button></div></Card></>;
  }

  if (screen === 'phone') {
    const phone = await source.getPhoneNumber();
    if (!phone) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/phone" /></>;
    return <>{header}<div className="grid gap-4 md:grid-cols-2"><Card><PhoneCall aria-hidden="true" className="text-[var(--accent)]"/><p className="mt-4 text-sm text-[var(--muted)]">{t('assigned')}</p><p className="mt-1 text-2xl font-semibold tracking-tight">{phone.e164}</p><div className="mt-4"><Badge tone="success">{common('active')}</Badge></div></Card><Card><CheckCircle2 aria-hidden="true" className="text-[var(--success)]"/><h2 className="mt-4 font-semibold">{t('forwarding')}</h2><p className="mt-2 text-[var(--muted)]">{format.dateTime(new Date(phone.forwardingVerifiedAt ?? phone.updatedAt), {dateStyle: 'long'})}</p><button className="mt-4 min-h-11 rounded-lg border px-4 font-semibold">{t('carrier')}</button></Card></div></>;
  }

  if (screen === 'analytics') {
    const [calls, usage] = await Promise.all([source.listCalls(), source.getUsage()]);
    if (!calls.length) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/calls" /></>;
    const languages = new Set(calls.flatMap((call) => call.languages));
    const minutes = Math.ceil(usage.seconds / 60);
    return <>{header}<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><Stat label={t('usage')} value={`${minutes} ${common('minutes')}`}/><Stat label={t('cost')} value={format.number(usage.costMicros / 1_000_000, {style: 'currency', currency: 'CAD'})}/><Stat label={t('languageMix')} value={languages.size}/><Stat label={t('outcomes')} value={new Set(calls.map((call) => call.outcome)).size}/></div><Card className="mt-4"><div className="flex h-44 items-end gap-2">{Array.from({length: 14}, (_, index) => <div key={index} className="min-w-0 flex-1 rounded-t bg-[var(--accent)]" style={{height: `${32 + ((index * 19) % 68)}%`}}/>)}</div></Card></>;
  }

  const [restaurant, usage] = await Promise.all([getCurrentRestaurant(), source.getUsage()]);
  if (!restaurant) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/settings" /></>;
  return <>{header}<div className="grid gap-4 md:grid-cols-2"><Card><h2 className="font-semibold">{t('team')}</h2><p className="mt-2 text-[var(--muted)]">{restaurant.name}</p></Card><Card><h2 className="font-semibold">{t('notifications')}</h2><Badge tone="success">{common('active')}</Badge></Card><Card><h2 className="font-semibold">{t('billing')}</h2><p className="mt-2 text-[var(--muted)]">{t('plan')} · {Math.ceil(usage.seconds / 60)} {common('minutes')}</p></Card><Card><h2 className="font-semibold">{t('legal')}</h2><p className="mt-2 text-[var(--muted)]">{t('recording')}</p></Card></div></>;
}
