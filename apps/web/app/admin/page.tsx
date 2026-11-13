import Link from 'next/link';
import {Search, ShieldAlert} from 'lucide-react';
import {getFormatter, getTranslations} from 'next-intl/server';
import {notFound} from 'next/navigation';

import {Badge, Card, DataTable, PageHeader, buttonStyles, inputBase} from '@/components/ui';
import {requireCapability} from '@/lib/auth/guards';
import {getDataSource} from '@/lib/data';
import {endSupportSession, startSupportSession, toggleFeatureFlag, togglePhoneKillSwitch} from './actions';

export default async function Page({searchParams}: {searchParams: Promise<Record<string, string | string[] | undefined>>}) {
  try { await requireCapability('accessAdmin'); } catch { notFound(); }
  const source = getDataSource();
  const t = await getTranslations('screens.admin');
  const format = await getFormatter();
  const [role, params, restaurants, phones, flags, auditLogs, activeSession] = await Promise.all([
    source.getViewerRole(), searchParams, source.listAdminRestaurants(), source.listAdminPhoneNumbers(),
    source.listFeatureFlags(), source.listAuditLogs(), source.getActiveSupportSession(),
  ]);
  if (role !== 'platform-admin') notFound();

  const rawQuery = Array.isArray(params.q) ? params.q[0] : params.q;
  const query = rawQuery?.trim() ?? '';
  const visibleRestaurants = restaurants.filter((restaurant) => restaurant.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const restaurantNames = new Map(restaurants.map((restaurant) => [restaurant.restaurantId, restaurant.name]));
  const flagState = (restaurantId: string | null): boolean => flags.find((flag) => flag.key === 'diner_payments' && flag.restaurantId === restaurantId)?.enabled ?? false;

  return <>
    <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')}/>
    {activeSession && <Card className="mb-4 border-[var(--warning)]"><div className="flex flex-wrap items-center justify-between gap-3"><p className="font-semibold">{t('activeSession', {restaurant: restaurantNames.get(activeSession.restaurantId) ?? activeSession.restaurantId})}</p><form action={endSupportSession}><input type="hidden" name="sessionId" value={activeSession.id}/><button className={buttonStyles('secondary')}>{t('endSession')}</button></form></div></Card>}
    <Card>
      <h2 className="font-semibold">{t('search')}</h2>
      <form method="get" className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1"><span className="sr-only">{t('search')}</span><Search aria-hidden="true" className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" size={18}/><input type="search" name="q" defaultValue={query} placeholder={t('searchPlaceholder')} className="min-h-11 w-full rounded-lg border bg-[var(--background)] pl-10 pr-3"/></label>
        <button className={buttonStyles('primary')}>{t('searchAction')}</button>
      </form>
    </Card>
    <Card className="mt-4">
      <h2 className="font-semibold">{t('usage')}</h2>
      {visibleRestaurants.length === 0 ? <div className="mt-4 grid min-h-40 place-items-center rounded-lg border border-dashed p-4 text-center"><div><p className="text-[var(--muted)]">{t('noRestaurants')}</p><Link href="/admin" className="mt-3 inline-flex min-h-11 items-center font-semibold text-[var(--accent-strong)]">{t('clearSearch')}</Link></div></div> : <div className="mt-3"><DataTable rows={visibleRestaurants} rowKey={(restaurant) => restaurant.restaurantId} caption={t('usage')} columns={[
        {key: 'restaurant', header: t('restaurant'), cell: (restaurant) => restaurant.name},
        {key: 'status', header: t('status'), cell: (restaurant) => <Badge tone="success">{t(`statuses.${restaurant.status}`)}</Badge>},
        {key: 'calls', header: t('calls'), numeric: true, cell: (restaurant) => restaurant.calls},
        {key: 'minutes', header: t('minutes'), numeric: true, cell: (restaurant) => format.number(restaurant.minutes, {maximumFractionDigits: 1})},
        {key: 'cost', header: t('cost'), numeric: true, cell: (restaurant) => format.number(restaurant.costMicros / 1_000_000, {style: 'currency', currency: 'CAD'})},
        {key: 'support', header: t('supportView'), cell: (restaurant) => <form action={startSupportSession} className="grid min-w-64 gap-2"><input type="hidden" name="restaurantId" value={restaurant.restaurantId}/><label className="sr-only" htmlFor={`support-${restaurant.restaurantId}`}>{t('reason')}</label><input id={`support-${restaurant.restaurantId}`} required minLength={10} name="reason" placeholder={t('reasonPlaceholder')} className={inputBase}/><button disabled={Boolean(activeSession)} className={buttonStyles('secondary')}><ShieldAlert aria-hidden="true" size={16}/>{t('startSession')}</button></form>},
      ]}/></div>}
    </Card>
    <div className="mt-4 grid gap-4 xl:grid-cols-2">
      <Card>
        <h2 className="font-semibold">{t('flags')}</h2>
        <div className="mt-3 grid gap-3">
          <FlagForm label={t('globalFlag')} flagLabel={t('dinerPaymentsFlag')} restaurantId={null} enabled={flagState(null)} onLabel={t('enabled')} offLabel={t('disabled')} actionLabel={t('toggle')}/>
          {restaurants.map((restaurant) => <FlagForm key={restaurant.restaurantId} label={restaurant.name} flagLabel={t('dinerPaymentsFlag')} restaurantId={restaurant.restaurantId} enabled={flagState(restaurant.restaurantId)} onLabel={t('enabled')} offLabel={t('disabled')} actionLabel={t('toggle')}/>) }
        </div>
      </Card>
      <Card>
        <h2 className="font-semibold">{t('killSwitch')}</h2>
        {phones.length === 0 ? <p className="mt-3 text-sm text-[var(--muted)]">{t('noNumbers')}</p> : <ul className="mt-3 grid gap-3">{phones.map((phone) => <li key={phone.id} className="rounded-lg border p-3"><div className="flex items-center justify-between gap-3"><div><p className="font-medium">{restaurantNames.get(phone.restaurantId) ?? phone.e164}</p><p className="text-sm text-[var(--muted)]">{phone.e164}</p></div><Badge tone={phone.killSwitch ? 'warning' : 'success'}>{phone.killSwitch ? t('killed') : t('answering')}</Badge></div><form action={togglePhoneKillSwitch} className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]"><input type="hidden" name="phoneNumberId" value={phone.id}/><input type="hidden" name="enabled" value={String(!phone.killSwitch)}/><label className="sr-only" htmlFor={`kill-${phone.id}`}>{t('reason')}</label><input id={`kill-${phone.id}`} required minLength={10} name="reason" placeholder={t('killReasonPlaceholder')} className={inputBase}/><button className={buttonStyles(phone.killSwitch ? 'secondary' : 'danger')}>{phone.killSwitch ? t('restoreNumber') : t('killNumber')}</button></form></li>)}</ul>}
      </Card>
    </div>
    <Card className="mt-4"><h2 className="font-semibold">{t('audit')}</h2>{auditLogs.length === 0 ? <div className="mt-3 grid min-h-28 place-items-center rounded-lg border border-dashed p-4 text-center text-sm text-[var(--muted)]">{t('auditEmpty')}</div> : <ul className="mt-3 divide-y">{auditLogs.map((entry) => <li key={entry.id} className="py-3"><p className="font-medium">{entry.action}</p><p className="text-sm text-[var(--muted)]">{entry.target} · {entry.reason}</p></li>)}</ul>}</Card>
  </>;
}

function FlagForm({label, flagLabel, restaurantId, enabled, onLabel, offLabel, actionLabel}: {label: string; flagLabel: string; restaurantId: string | null; enabled: boolean; onLabel: string; offLabel: string; actionLabel: string}) {
  return <form action={toggleFeatureFlag} className="flex min-h-14 flex-wrap items-center justify-between gap-3 rounded-lg border p-3"><input type="hidden" name="key" value="diner_payments"/><input type="hidden" name="restaurantId" value={restaurantId ?? ''}/><input type="hidden" name="enabled" value={String(!enabled)}/><div><p className="font-medium">{label}</p><p className="text-sm text-[var(--muted)]">{flagLabel} · {enabled ? onLabel : offLabel}</p></div><button className={buttonStyles('secondary')}>{actionLabel}</button></form>;
}
