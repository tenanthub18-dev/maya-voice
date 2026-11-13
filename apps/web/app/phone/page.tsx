import {AlertTriangle, CheckCircle2, KeyRound, PhoneCall} from 'lucide-react';
import {getTranslations} from 'next-intl/server';
import {getDataSource} from '@/lib/data';
import {Badge, Card, EmptyState, PageHeader} from '@/components/ui';
import {OperationalBanners} from '@/components/operational-banners';

export default async function Page() {
  const source = getDataSource();
  const t = await getTranslations('screens.phone');
  const common = await getTranslations('common');
  const operational = await getTranslations('operational');
  const phone = await source.getPhoneNumber();
  const header = <PageHeader eyebrow={t('eyebrow')} title={t('title')} description={t('description')}/>;

  if (!phone) return <>{header}<EmptyState message={t('empty')} action={t('action')} href="/phone"/></>;
  if (phone.status === 'released') return <>{header}<OperationalBanners notices={[{
    id: 'number-released', tone: 'danger', title: operational('releasedTitle'), body: operational('releasedBody'),
  }]}/><EmptyState message={t('empty')} action={t('action')} href="/onboarding/7"/></>;

  const verified = phone.forwardingVerifiedAt !== null;
  return <>
    {header}
    {!verified && <div role="alert" className="mb-4 flex items-start gap-3 rounded-lg border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] p-4 text-[var(--danger)]"><AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={22}/><div><h2 className="font-semibold">{t('notVerified')}</h2><p className="mt-1 text-sm">{t('warning')}</p></div></div>}
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
      <Card>
        <PhoneCall aria-hidden="true" className="text-[var(--accent-strong)]" size={24}/>
        <p className="mt-4 text-sm text-[var(--muted)]">{t('assigned')}</p>
        <p className="mt-1 text-2xl font-semibold tracking-tight">{phone.e164}</p>
        <div className="mt-4 flex flex-wrap gap-2"><Badge tone={phone.status === 'active' ? 'success' : 'warning'}>{common(phone.status)}</Badge><Badge tone={verified ? 'success' : 'warning'}>{verified ? t('verified') : t('notVerified')}</Badge></div>
        <div className="mt-5 grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          <DisabledAction label={t('buy')} tooltip={t('needsKey')}/>
          <DisabledAction label={t('release')} tooltip={t('needsKey')}/>
        </div>
        <p id="telnyx-help" className="mt-3 flex items-start gap-2 text-xs text-[var(--muted)]"><KeyRound aria-hidden="true" className="mt-0.5 shrink-0" size={14}/>{t('disabledHelp')}</p>
      </Card>
      <Card>
        <div className="flex items-start justify-between gap-3"><div><p className="text-sm text-[var(--muted)]">{t('forwarding')}</p><h2 className="mt-1 text-xl font-semibold">{t('destination', {number: phone.e164})}</h2></div>{verified ? <CheckCircle2 aria-hidden="true" className="shrink-0 text-[var(--success)]" size={24}/> : <AlertTriangle aria-hidden="true" className="shrink-0 text-[var(--danger)]" size={24}/>}</div>
        <h3 className="mt-6 font-semibold">{t('carrier')}</h3>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <CarrierCard name={t('bell')} steps={t('bellSteps')}/>
          <CarrierCard name={t('rogers')} steps={t('rogersSteps')}/>
          <CarrierCard name={t('telus')} steps={t('telusSteps')}/>
        </div>
      </Card>
    </div>
  </>;
}

function CarrierCard({name, steps}: {name: string; steps: string}) {
  return <section className="rounded-lg border bg-[var(--background)] p-4"><h4 className="font-semibold">{name}</h4><p className="mt-2 text-sm text-[var(--muted)]">{steps}</p></section>;
}

function DisabledAction({label, tooltip}: {label: string; tooltip: string}) {
  return <span className="block" title={tooltip}><button type="button" disabled aria-describedby="telnyx-help" className="min-h-11 w-full rounded-lg border px-4 font-semibold opacity-55">{label}</button></span>;
}
