'use client';

import {useState, useTransition} from 'react';
import {useRouter} from 'next/navigation';
import {ArrowLeft, ArrowRight, Phone, Utensils} from 'lucide-react';
import {useTranslations} from 'next-intl';
import type {Agent, Faq, Hours, Language, MenuItem, OnboardingState, OnboardingStep, PhoneNumber, Restaurant, SaveOnboardingStateInput, SlotsConfig} from '@/lib/data/types';
import {WebsiteImportFlow} from './onboarding-import-flow';
import {NumberLifecycleFlow} from './onboarding-number-flow';
import {CheckoutButton} from './billing-actions';
import {VoicePreviewButton} from './voice-preview-button';
import {Badge, Card, PageHeader, buttonStyles, inputBase} from './ui';

export interface ReviewPayload {
  hours: Array<Pick<Hours, 'id' | 'weekday' | 'openTime' | 'closeTime'>>;
  menuItems: Array<Pick<MenuItem, 'id' | 'name' | 'priceCents'>>;
  faqs: Array<Pick<Faq, 'id' | 'question' | 'answer'>>;
}

export type WizardSavePayload = SaveOnboardingStateInput & {review?: ReviewPayload};

interface Props {
  step: OnboardingStep;
  state: OnboardingState;
  restaurant: Restaurant;
  hours: Hours[];
  menuItems: MenuItem[];
  faqs: Faq[];
  agent: Agent;
  slots: SlotsConfig;
  saveStep: (payload: WizardSavePayload) => Promise<void>;
  initialPhone?: PhoneNumber | null;
}

const inputClass = inputBase;
const primaryButton = buttonStyles('primary');
const secondaryButton = buttonStyles('secondary');
const languages: Language[] = ['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar'];
const voices = ['warm', 'clear', 'calm'] as const;
const onboardingPreviewText = 'Hello, thank you for calling. How may I help you?';

export function OnboardingWizard(props: Props) {
  const {step, state} = props;
  const t = useTranslations('screens.onboarding');
  const common = useTranslations('common');
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, startTransition] = useTransition();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    const form = new FormData(event.currentTarget);
    const payload = payloadForStep(step, form, state, props);
    if (payload.error !== undefined) {
      setError(t(payload.error));
      return;
    }
    startTransition(async () => {
      try {
        await props.saveStep(payload.value);
        if (step < 7) router.push(`/onboarding/${step + 1}`);
      } catch {
        setError(t('errors.save'));
      }
    });
  };

  return <div className="mx-auto max-w-4xl">
    <PageHeader eyebrow={t('eyebrow')} title={t(`steps.${step}.title`)} description={t(`steps.${step}.description`)}/>
    <WizardProgress step={step} completed={state.completedSteps} t={t}/>
    {error && <div role="alert" className="mb-4 rounded-lg border border-[var(--danger)] bg-[var(--surface)] p-3 text-[var(--danger)]">{error}</div>}
    {step === 2 ? <WebsiteImportFlow restaurantId={props.restaurant.id} basics={state.basics} saveStep={async (payload) => { await props.saveStep(payload); router.push('/onboarding/3'); }}/> :
      <form aria-label={t(`steps.${step}.formLabel`)} onSubmit={submit} className="space-y-5">
        {step === 1 && <Basics state={state} t={t}/>}
        {step === 3 && <ReviewTables {...props} t={t}/>}
        {step === 4 && <VoiceSelection state={state} common={common} t={t}/>}
        {step === 5 && <Rules state={state} slots={props.slots} t={t}/>}
        {step === 6 && <TestCall t={t}/>}
        {step === 7 && <NumberAndPlan state={state} restaurantId={props.restaurant.id} initialPhone={props.initialPhone ?? null} saveStep={props.saveStep} t={t}/>}
        <WizardActions step={step} pending={pending} t={t}/>
      </form>}
  </div>;
}

function WizardProgress({step, completed, t}: {step: OnboardingStep; completed: OnboardingStep[]; t: ReturnType<typeof useTranslations>}) {
  return <div className="mb-6" role="progressbar" aria-label={t('progressLabel')} aria-valuemin={1} aria-valuemax={7} aria-valuenow={step}>
    <div className="mb-2 flex items-center justify-between text-sm"><span>{t('progress', {step})}</span><span className="text-[var(--muted)]">{Math.round(step / 7 * 100)}%</span></div>
    <div className="grid grid-cols-7 gap-1" aria-hidden="true">{([1, 2, 3, 4, 5, 6, 7] as OnboardingStep[]).map((item) => <span key={item} className={`h-2 rounded-full ${item <= step || completed.includes(item) ? 'bg-[var(--accent)]' : 'bg-[var(--surface-raised)]'}`}/>)}</div>
  </div>;
}

function Basics({state, t}: {state: OnboardingState; t: ReturnType<typeof useTranslations>}) {
  return <Card className="grid gap-4 sm:grid-cols-2"><Field name="name" label={t('basics.name')} defaultValue={state.basics.name}/><Field name="address" label={t('basics.address')} defaultValue={state.basics.address}/><Field name="websiteUrl" label={t('basics.website')} type="url" defaultValue={state.basics.websiteUrl}/><Field name="cuisine" label={t('basics.cuisine')} defaultValue={state.basics.cuisine}/></Card>;
}

function ReviewTables({hours, menuItems, faqs, t}: Props & {t: ReturnType<typeof useTranslations>}) {
  const [reviewHours, setReviewHours] = useState(hours);
  return <div className="space-y-4">
    <ReviewSection title={t('review.menu')} empty={t('review.emptyMenu')} emptyAction={<a className={secondaryButton} href="/agent?tab=knowledge&section=menu">{t('review.manageMenu')}</a>} icon={<Utensils aria-hidden="true"/>}>{menuItems.map((item) => <div key={item.id} className="grid grid-cols-[1fr_112px] gap-2 border-t py-3"><Field name={`menu-name-${item.id}`} label={t('review.itemName')} defaultValue={item.name}/><Field name={`menu-price-${item.id}`} label={t('review.price')} type="number" defaultValue={(item.priceCents / 100).toFixed(2)}/></div>)}</ReviewSection>
    <ReviewSection title={t('review.hours')} empty={t('review.emptyHours')} emptyAction={<button type="button" className={secondaryButton} onClick={() => setReviewHours(Array.from({length: 7}, (_, weekday) => ({id: `new-hours-${weekday}`, restaurantId: '', weekday, openTime: '11:00', closeTime: '22:00', createdAt: '', updatedAt: ''})))}>{t('review.addHours')}</button>}>{[...reviewHours].sort((a, b) => a.weekday - b.weekday).map((row) => <div key={row.id} className="grid grid-cols-[1fr_1fr] gap-2 border-t py-3"><input type="hidden" name={`hours-id-${row.id}`} value={row.id}/><Field name={`hours-open-${row.id}`} label={t('review.open')} type="time" defaultValue={row.openTime}/><Field name={`hours-close-${row.id}`} label={t('review.close')} type="time" defaultValue={row.closeTime}/></div>)}</ReviewSection>
    <ReviewSection title={t('review.faqs')} empty={t('review.emptyFaqs')} emptyAction={<a className={secondaryButton} href="/agent?tab=knowledge&section=faqs">{t('review.manageFaqs')}</a>}>{faqs.map((faq) => <div key={faq.id} className="space-y-2 border-t py-3"><Field name={`faq-question-${faq.id}`} label={t('review.question')} defaultValue={faq.question}/><label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{t('review.answer')}</span><textarea className={inputClass} name={`faq-answer-${faq.id}`} defaultValue={faq.answer} rows={3}/></label></div>)}</ReviewSection>
  </div>;
}

function ReviewSection({title, empty, emptyAction, icon, children}: {title: string; empty: string; emptyAction: React.ReactNode; icon?: React.ReactNode; children: React.ReactNode}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return <Card><div className="mb-3 flex items-center gap-2">{icon}<h2 className="text-lg font-semibold">{title}</h2></div>{hasChildren ? children : <div className="rounded-lg bg-[var(--surface-raised)] p-4"><p className="mb-3 text-[var(--muted)]">{empty}</p>{emptyAction}</div>}</Card>;
}

function VoiceSelection({state, common, t}: {state: OnboardingState; common: ReturnType<typeof useTranslations>; t: ReturnType<typeof useTranslations>}) {
  return <div className="space-y-4"><Card><Field name="personaName" label={t('voice.hostName')} defaultValue={state.voice.personaName}/><div className="mt-4 grid gap-3 sm:grid-cols-3">{voices.map((voice) => <div key={voice} className="relative flex min-h-32 flex-col rounded-lg border p-4 has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-soft)]"><label className="cursor-pointer"><input className="absolute right-3 top-3 size-5 accent-[var(--accent)]" type="radio" name="selectedVoice" value={voice} defaultChecked={state.voice.selectedVoice === voice}/><span className="font-semibold">{t(`voice.cards.${voice}`)}</span><span className="mt-1 block text-sm text-[var(--muted)]">{t(`voice.descriptions.${voice}`)}</span></label><div className="mt-auto"><VoicePreviewButton language={state.voice.primaryLanguage} text={onboardingPreviewText} label={`${t('voice.preview')} ${t(`voice.cards.${voice}`)}`} unavailable={t('voice.unavailable')}/></div></div>)}</div></Card><Card><h2 className="font-semibold">{t('voice.languages')}</h2><div className="mt-3 grid gap-2 sm:grid-cols-2">{languages.map((language) => <label key={language} className="flex min-h-11 items-center gap-3 rounded-lg border px-3"><input className="size-5 accent-[var(--accent)]" type="checkbox" name="enabledLanguages" value={language} defaultChecked={state.voice.enabledLanguages.includes(language)}/><span>{common(`languages.${language}`)}</span></label>)}</div><label className="mt-4 block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{t('voice.primary')}</span><select className={inputClass} name="primaryLanguage" defaultValue={state.voice.primaryLanguage}>{languages.map((language) => <option key={language} value={language}>{common(`languages.${language}`)}</option>)}</select></label></Card></div>;
}

function Rules({state, slots, t}: {state: OnboardingState; slots: SlotsConfig; t: ReturnType<typeof useTranslations>}) {
  return <div className="grid gap-4 sm:grid-cols-2"><Card><h2 className="mb-3 font-semibold">{t('rules.bookings')}</h2><div className="space-y-3"><Field name="maxParty" label={t('rules.maxParty')} type="number" defaultValue={String(state.rules.maxParty || slots.maxParty)}/><Field name="bookingWindowDays" label={t('rules.window')} type="number" defaultValue={String(state.rules.bookingWindowDays || slots.bookingWindowDays)}/><label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="takeoutEnabled" className="size-5 accent-[var(--accent)]" defaultChecked={state.rules.takeoutEnabled}/>{t('rules.takeout')}</label></div></Card><Card><h2 className="mb-3 font-semibold">{t('rules.calls')}</h2><div className="space-y-3"><Field name="transferPhone" label={t('rules.transfer')} type="tel" defaultValue={state.rules.transferPhone}/><label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{t('rules.deposit')}</span><select className={inputClass} name="depositRule" defaultValue={state.rules.depositRule}><option value="none">{t('rules.depositOptions.none')}</option><option value="large-parties">{t('rules.depositOptions.largeParties')}</option></select></label></div></Card></div>;
}

function TestCall({t}: {t: ReturnType<typeof useTranslations>}) {
  return <div className="space-y-4"><div role="status" className="rounded-lg border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] p-3 font-semibold text-[var(--warning)]">{t('testCall.testMode')}</div><Card className="grid min-h-80 place-items-center text-center"><div><Badge tone="warning">{t('testCall.needsWorker')}</Badge><button type="button" disabled aria-label={t('testCall.start')} className="mx-auto mt-8 grid size-28 place-items-center rounded-full bg-[var(--surface-raised)] text-[var(--muted)]"><Phone aria-hidden="true" size={38}/></button><p className="mt-4 font-semibold">{t('testCall.start')}</p><div role="meter" aria-label={t('testCall.mic')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} className="mx-auto mt-6 flex h-12 items-end justify-center gap-1">{[16, 24, 32, 24, 16].map((height) => <span key={height} className="w-2 rounded-full bg-[var(--surface-raised)]" style={{height}}/>)}</div><p className="mt-4 max-w-sm text-sm text-[var(--muted)]">{t('testCall.help')}</p></div></Card></div>;
}

function NumberAndPlan({state, restaurantId, initialPhone, saveStep, t}: {state: OnboardingState; restaurantId: string; initialPhone: PhoneNumber | null; saveStep: Props['saveStep']; t: ReturnType<typeof useTranslations>}) {
  return <div className="space-y-4"><NumberLifecycleFlow restaurantId={restaurantId} initialPhone={initialPhone}/><Card><h2 className="text-lg font-semibold">{t('plan.heading')}</h2><p className="mb-4 mt-2 text-[var(--muted)]">{t('plan.pricingPending')}</p><CheckoutButton initialPlan={state.number.plan} prepare={(plan) => saveStep({number: {...state.number, plan}, completedStep: 7})}/></Card></div>;
}

function WizardActions({step, pending, t}: {step: OnboardingStep; pending: boolean; t: ReturnType<typeof useTranslations>}) {
  if (step === 7) return null;
  return <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">{step > 1 ? <a href={`/onboarding/${step - 1}`} className={secondaryButton}><ArrowLeft aria-hidden="true" size={18}/>{t('back')}</a> : <span/>}<button disabled={pending} className={primaryButton}>{pending ? t('saving') : step === 6 ? t('finish') : t('continue')}<ArrowRight aria-hidden="true" size={18}/></button></div>;
}

function Field({name, label, type = 'text', defaultValue, disabled}: {name: string; label: string; type?: string; defaultValue?: string; disabled?: string}) {
  return <label className="block text-sm font-medium"><span className="mb-1 block text-[var(--muted)]">{label}</span><input className={inputClass} name={name} type={type} defaultValue={defaultValue} disabled={disabled === 'true'}/></label>;
}

function payloadForStep(step: OnboardingStep, form: FormData, state: OnboardingState, props: Props): {value: WizardSavePayload; error?: never} | {value?: never; error: string} {
  const text = (name: string) => String(form.get(name) ?? '').trim();
  if (step === 1) {
    const basics = {name: text('name'), address: text('address'), websiteUrl: text('websiteUrl'), cuisine: text('cuisine')};
    if (!basics.name || !basics.address) return {error: 'errors.basics'};
    return {value: {basics, completedStep: 1}};
  }
  if (step === 2) return {value: {basics: {...state.basics, websiteUrl: text('websiteUrl')}, completedStep: 2}};
  if (step === 3) {
    const submittedHours = [...form.keys()].filter((key) => key.startsWith('hours-open-')).map((key) => key.slice('hours-open-'.length));
    if (!submittedHours.length || submittedHours.some((id) => !text(`hours-open-${id}`) || !text(`hours-close-${id}`))) return {error: 'errors.hours'};
    return {value: {completedStep: 3, review: {
      hours: submittedHours.map((id) => ({id, weekday: id.startsWith('new-hours-') ? Number(id.slice('new-hours-'.length)) : props.hours.find((row) => row.id === id)?.weekday ?? -1, openTime: text(`hours-open-${id}`), closeTime: text(`hours-close-${id}`)})),
      menuItems: props.menuItems.map((row) => ({id: row.id, name: text(`menu-name-${row.id}`), priceCents: Math.round(Number(text(`menu-price-${row.id}`)) * 100)})),
      faqs: props.faqs.map((row) => ({id: row.id, question: text(`faq-question-${row.id}`), answer: text(`faq-answer-${row.id}`)}))
    }}};
  }
  if (step === 4) {
    const enabledLanguages = form.getAll('enabledLanguages').map(String) as Language[];
    const primaryLanguage = text('primaryLanguage') as Language;
    const voice = {personaName: text('personaName'), selectedVoice: text('selectedVoice'), enabledLanguages, primaryLanguage};
    if (!voice.personaName || !enabledLanguages.length || !enabledLanguages.includes(primaryLanguage)) return {error: 'errors.voice'};
    return {value: {voice, completedStep: 4}};
  }
  if (step === 5) {
    const rules = {maxParty: Number(text('maxParty')), bookingWindowDays: Number(text('bookingWindowDays')), takeoutEnabled: form.has('takeoutEnabled'), depositRule: text('depositRule'), transferPhone: text('transferPhone')};
    if (!Number.isSafeInteger(rules.maxParty) || rules.maxParty < 1 || !Number.isSafeInteger(rules.bookingWindowDays) || rules.bookingWindowDays < 1 || !/^\+[1-9]\d{7,14}$/.test(rules.transferPhone)) return {error: 'errors.rules'};
    return {value: {rules, completedStep: 5}};
  }
  if (step === 6) return {value: {testCallAcknowledged: true, completedStep: 6}};
  return {value: {completedStep: 7}};
}
