import {getFormatter, getTranslations} from 'next-intl/server';
import {getDataSource} from '@/lib/data';
import {Badge, Card, EmptyState, PageHeader, Select} from '@/components/ui';
import {SettingsControls} from './settings-controls';
import {inviteMemberAction} from '@/app/invite/actions';
import {createServerAuthProvider} from '@/lib/auth/server';
import {BillingPortalButton} from '@/components/billing-actions';
import {evaluateSpendCap} from '@/lib/billing/spend-cap';
import {getPaymentStatus} from '@/lib/operations/status';
import {OperationalBanners, type OperationalNotice} from '@/components/operational-banners';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {isFlagEnabled} from '@/lib/feature-flags';
import {PaymentSettingsCard} from '@/components/payment-settings-card';

export default async function Page() {
  const source = getDataSource();
  const t = await getTranslations('screens.settings');
  const operational = await getTranslations('operational');
  const format = await getFormatter();
  const [organization, restaurant, memberships, notifications, usage, invoices, legal, user] = await Promise.all([
    source.getOrganization(), getCurrentRestaurant(), source.listMemberships(), source.getNotificationPreferences(), source.getUsage(), source.listInvoices(), source.getLegalSettings(), (await createServerAuthProvider()).getUser()
  ]);
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')}/>;
  if (!organization) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/settings"/></>;
  const usedMinutes = usage.seconds / 60;
  const dinerPaymentsEnabled = await isFlagEnabled('diner_payments', restaurant.id, source);
  const spendDecision = evaluateSpendCap({currentCostMicros: usage.costMicros, projectedCallCostMicros: 0, spendCapCents: organization.spendCapCents});
  const payment = getPaymentStatus(new Date(), organization.lastInvoiceStatus, organization.stripeInvoiceEventCreatedAt);
  const notices: OperationalNotice[] = payment.paymentGrace
    ? [{id: 'payment-grace', tone: 'warning', title: operational('graceTitle'), body: operational('graceBody')}]
    : payment.paymentBlocked
      ? [{id: 'payment-blocked', tone: 'danger', title: operational('paymentBlockedTitle'), body: operational('paymentBlockedBody')}]
      : [];

  return <>
    {header}
    <OperationalBanners notices={notices}/>
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <h2 className="font-semibold">{t('team')}</h2>
        <ul className="mt-3 divide-y">{memberships.map((member) => <li key={member.id} className="flex min-h-16 items-center justify-between gap-3 py-2"><div className="min-w-0"><p className="font-medium">{member.name}</p><p className="truncate text-sm text-[var(--muted)]">{member.email}</p></div><Badge>{t(`roles.${member.role}`)}</Badge></li>)}</ul>
        {user?.role === 'owner' && <form action={inviteMemberAction} className="mt-5 grid gap-3 border-t pt-5"><input type="hidden" name="organizationId" value={organization.id}/><label className="grid gap-1 text-sm font-medium">{t('inviteEmail')}<input required type="email" name="email" className="min-h-11 rounded-lg border bg-[var(--background)] px-3"/></label><Select name="role" label={t('inviteRole')}><option value="staff">{t('roles.staff')}</option><option value="owner">{t('roles.owner')}</option></Select><button className="min-h-11 rounded-lg bg-[var(--accent)] px-4 font-semibold text-[var(--on-accent)]">{t('sendInvitation')}</button></form>}
      </Card>
      <SettingsControls notifications={notifications} spendCapCents={organization.spendCapCents} legal={legal} restaurantId={restaurant.id} province={restaurant.province} canManagePrivacy={user?.role === 'owner'}/>
      <Card>
        <div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold">{t('billing')}</h2><p className="mt-1 text-sm text-[var(--muted)]">{organization.name}</p></div>{dinerPaymentsEnabled && <Badge tone="accent">{t('dinerPaymentsEnabled')}</Badge>}</div>
        <p className="mt-5 font-semibold">{t('pricingPending')}</p>
        <p className="mt-2 text-sm text-[var(--muted)]">{t('usageCurrent', {used: format.number(usedMinutes, {maximumFractionDigits: 1})})}</p>
        {spendDecision.warning && <p role="status" className="mt-3 rounded-lg border border-[var(--warning)] p-3 text-sm font-semibold text-[var(--warning)]">{spendDecision.allowed ? t('spendWarning') : t('spendBlocked')}</p>}
        <div className="mt-4"><BillingPortalButton/></div>
        <h3 className="mt-6 font-semibold">{t('invoices')}</h3>
        {invoices.length === 0 ? <div className="mt-3 grid min-h-24 place-items-center rounded-lg border border-dashed p-4 text-center text-sm text-[var(--muted)]">{t('invoiceEmpty')}</div> : <ul className="mt-3 divide-y">{invoices.map((invoice) => <li key={invoice.id} className="flex min-h-12 items-center justify-between"><span>{invoice.period}</span><strong>{format.number(invoice.totalCents / 100, {style: 'currency', currency: 'CAD'})}</strong></li>)}</ul>}
      </Card>
      {dinerPaymentsEnabled && user?.role === 'owner' && <PaymentSettingsCard/>}
    </div>
  </>;
}
