'use server';

import {requireActionCapability} from '@/lib/auth/guards';
import type {WizardSavePayload} from '@/components/onboarding-screen';
import {getDataSource} from '@/lib/data';
import type {ImportJob} from '@/lib/data/types';
import {assertStrictActionObject} from '@/lib/security/actions';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import {getCurrentRestaurant} from '@/lib/restaurant';
import {z} from 'zod';

export async function saveOnboardingStep(payload: WizardSavePayload): Promise<void> {
  assertStrictActionObject(payload, ['basics', 'review', 'voice', 'rules', 'completedStep', 'importJobId', 'testCallAcknowledged', 'number']);
  await requireActionCapability('publishAgent');
  const source = getDataSource();
  const {review, ...stateUpdate} = payload;
  const currentState = await source.getOnboardingState();
  if (payload.completedStep !== undefined && payload.completedStep > currentState.currentStep) {
    throw new Error('ONBOARDING_STEP_ORDER');
  }

  const [existingHours, existingMenuItems, existingFaqs, restaurant, slots] = await Promise.all([
    source.listHours(), source.listMenuItems(), source.listFaqs(), getCurrentRestaurant(), source.getSlotsConfig()
  ]);
  validatePayload(payload, {existingHours, existingMenuItems, existingFaqs, restaurant, slots});

  if (payload.basics) {
    await source.updateRestaurantBasics({name: payload.basics.name, address: payload.basics.address});
  }

  if (review) {
    await Promise.all([
      ...review.hours.map((row) => row.id.startsWith('new-hours-') ? source.createHours({weekday: row.weekday, openTime: row.openTime, closeTime: row.closeTime}) : source.updateHours(row.id, {openTime: row.openTime, closeTime: row.closeTime})),
      ...review.menuItems.map((row) => {
        const current = existingMenuItems.find((item) => item.id === row.id);
        if (!current) throw new Error('MENU_ITEM_NOT_FOUND');
        return source.updateMenuItem(row.id, {...current, name: row.name, priceCents: row.priceCents});
      }),
      ...review.faqs.map((row) => {
        const current = existingFaqs.find((faq) => faq.id === row.id);
        if (!current) throw new Error('FAQ_NOT_FOUND');
        return source.updateFaq(row.id, {...current, question: row.question, answer: row.answer});
      })
    ]);
  }

  if (payload.voice) {
    const agent = await source.getAgent();
    await Promise.all([
      source.updateAgent(agent.id, {personaName: payload.voice.personaName, fillerLevel: agent.fillerLevel}),
      source.updateRestaurantLanguages(payload.voice.enabledLanguages, payload.voice.primaryLanguage)
    ]);
  }

  if (payload.rules) {
    await Promise.all([
      source.updateRestaurantRules(payload.rules.transferPhone, restaurant.transferHours),
      source.updateSlotsConfig({...slots, maxParty: payload.rules.maxParty, bookingWindowDays: payload.rules.bookingWindowDays})
    ]);
  }

  await source.saveOnboardingState(stateUpdate);
  await invalidateAfterWrite();
}

function validatePayload(payload: WizardSavePayload, data: {
  existingHours: Awaited<ReturnType<ReturnType<typeof getDataSource>['listHours']>>;
  existingMenuItems: Awaited<ReturnType<ReturnType<typeof getDataSource>['listMenuItems']>>;
  existingFaqs: Awaited<ReturnType<ReturnType<typeof getDataSource>['listFaqs']>>;
  restaurant: Awaited<ReturnType<ReturnType<typeof getDataSource>['getRestaurant']>>;
  slots: Awaited<ReturnType<ReturnType<typeof getDataSource>['getSlotsConfig']>>;
}): void {
  const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (payload.basics && (!payload.basics.name.trim() || !payload.basics.address.trim())) throw new Error('RESTAURANT_BASICS_REQUIRED');
  if (payload.review) {
    const weekdays = new Set(data.existingHours.map((row) => row.weekday));
    for (const row of payload.review.hours) {
      if (!validTime(row.openTime) || !validTime(row.closeTime) || row.openTime >= row.closeTime) throw new Error('HOURS_INVALID');
      if (row.id.startsWith('new-hours-')) {
        if (!Number.isSafeInteger(row.weekday) || row.weekday < 0 || row.weekday > 6 || weekdays.has(row.weekday)) throw new Error('WEEKDAY_INVALID');
        weekdays.add(row.weekday);
      } else if (!data.existingHours.some((item) => item.id === row.id)) throw new Error('HOURS_NOT_FOUND');
    }
    for (const row of payload.review.menuItems) {
      if (!data.existingMenuItems.some((item) => item.id === row.id) || !row.name.trim() || !Number.isSafeInteger(row.priceCents) || row.priceCents < 0) throw new Error('MENU_ITEM_INVALID');
    }
    for (const row of payload.review.faqs) {
      if (!data.existingFaqs.some((item) => item.id === row.id) || !row.question.trim() || !row.answer.trim()) throw new Error('FAQ_INVALID');
    }
  }
  if (payload.voice && (!payload.voice.personaName.trim() || !payload.voice.enabledLanguages.length || !payload.voice.enabledLanguages.includes(payload.voice.primaryLanguage))) throw new Error('VOICE_INVALID');
  if (payload.rules) {
    const daily = data.restaurant.transferHours.daily?.split('-') ?? [];
    const transferStart = data.restaurant.transferHours.start ?? daily[0] ?? '';
    const transferEnd = data.restaurant.transferHours.end ?? daily[1] ?? '';
    if (!/^\+[1-9]\d{7,14}$/.test(payload.rules.transferPhone) || !validTime(transferStart) || !validTime(transferEnd) || transferStart >= transferEnd || !Number.isSafeInteger(payload.rules.maxParty) || payload.rules.maxParty < 1 || !Number.isSafeInteger(payload.rules.bookingWindowDays) || payload.rules.bookingWindowDays < 1 || data.slots.slotMinutes < 1) throw new Error('RULES_INVALID');
  }
}

export async function startWebsiteImport(url: string): Promise<ImportJob> {
  url = z.string().url().max(2_048).parse(url);
  await requireActionCapability('publishAgent');
  const source = getDataSource();
  const job = await source.startImportJob(url);
  const state = await source.getOnboardingState();
  await source.saveOnboardingState({basics: {...state.basics, websiteUrl: job.url}, importJobId: job.id});
  await invalidateAfterWrite();
  return job;
}

export async function pollWebsiteImport(id: string): Promise<ImportJob> {
  id = z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/u).parse(id);
  await requireActionCapability('viewOperations');
  return getDataSource().getImportJob(id);
}
