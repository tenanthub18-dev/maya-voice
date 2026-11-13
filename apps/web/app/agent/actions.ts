'use server';

import {redirect} from 'next/navigation';
import {requireActionCapability} from '@/lib/auth/guards';
import {getDataSource, type DataSource, type Language, type SaveFaqInput, type SaveHoursOverrideInput, type SaveMenuItemInput, type SaveMenuModifierInput, type SavePolicyInput} from '@/lib/data';
import {acceptPromptProposal} from '@/lib/testcall/draft';
import type {PromptChangeProposal} from '@/lib/testcall/transport';
import {assertStrictActionObject, assertStrictFormData} from '@/lib/security/actions';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import {getCurrentRestaurant} from '@/lib/restaurant';

// Next.js Server Action mutation/revalidation contract: https://nextjs.org/docs/app/getting-started/mutating-data
const knownErrors = new Set(['PERSONA_REQUIRED', 'LANGUAGE_REQUIRED', 'PRIMARY_LANGUAGE_DISABLED', 'PHONE_INVALID', 'TRANSFER_HOURS_INVALID', 'BOOKING_RULES_INVALID', 'TITLE_REQUIRED', 'CONTENT_REQUIRED', 'PRICE_INVALID', 'HOURS_INVALID', 'DATE_INVALID', 'DATE_DUPLICATE', 'MENU_ITEM_NOT_FOUND', 'NO_DRAFT', 'STALE_TEST_CALL_DRAFT']);

export async function acceptTestCallFeedback(draftId: string, proposal: PromptChangeProposal): Promise<void> {
  assertStrictActionObject(proposal, ['section', 'before', 'after']);
  await requireActionCapability('publishAgent');
  const source = getDataSource();
  let error = '';
  try { await acceptPromptProposal(source, draftId, proposal); } catch (caught) { error = errorCode(caught); }
  if (error) redirect(`/agent?tab=testCall&error=${error}`);
  await invalidateAfterWrite();
  redirect('/agent?tab=testCall&saved=1');
}

export async function savePersona(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'personaName', 'fillerLevel']);
  await mutate('persona', async (source) => source.updateAgent(field(formData, 'id'), {personaName: field(formData, 'personaName'), fillerLevel: field(formData, 'fillerLevel') as 'none' | 'low' | 'natural'}));
}

export async function saveLanguages(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['languages', 'primaryLanguage']);
  const launchLanguages: Language[] = ['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar'];
  const enabled = launchLanguages.filter((language) => formData.getAll('languages').includes(language));
  await mutate('languages', async (source) => source.updateRestaurantLanguages(enabled, field(formData, 'primaryLanguage') as Language));
}

export async function saveMenuItem(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'name', 'description', 'price', 'category', 'dietaryTags', 'available']);
  const id = field(formData, 'id');
  const input: SaveMenuItemInput = {name: field(formData, 'name'), description: field(formData, 'description'), priceCents: cents(field(formData, 'price')), category: field(formData, 'category'), dietaryTags: field(formData, 'dietaryTags').split(',').map((value) => value.trim()).filter(Boolean), available: formData.get('available') === 'on'};
  await mutate('knowledge&knowledge=menu', async (source) => id ? source.updateMenuItem(id, input) : source.createMenuItem(input));
}

export async function deleteMenuItem(formData: FormData): Promise<void> { assertStrictFormData(formData, ['id']); await mutate('knowledge&knowledge=menu', (source) => source.deleteMenuItem(field(formData, 'id'))); }

export async function saveModifier(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'menuItemId', 'name', 'price', 'required', 'maxSelect']);
  const id = field(formData, 'id');
  const input: SaveMenuModifierInput = {menuItemId: field(formData, 'menuItemId'), name: field(formData, 'name'), priceDeltaCents: cents(field(formData, 'price')), required: formData.get('required') === 'on', maxSelect: Number(field(formData, 'maxSelect'))};
  await mutate('knowledge&knowledge=menu', async (source) => id ? source.updateMenuModifier(id, input) : source.createMenuModifier(input));
}

export async function deleteModifier(formData: FormData): Promise<void> { assertStrictFormData(formData, ['id']); await mutate('knowledge&knowledge=menu', (source) => source.deleteMenuModifier(field(formData, 'id'))); }

export async function saveRegularHours(formData: FormData): Promise<void> { assertStrictFormData(formData, ['id', 'openTime', 'closeTime']); await mutate('knowledge&knowledge=hours', (source) => source.updateHours(field(formData, 'id'), {openTime: field(formData, 'openTime'), closeTime: field(formData, 'closeTime')})); }

export async function saveHoursOverride(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'date', 'closed', 'openTime', 'closeTime']);
  const id = field(formData, 'id');
  const closed = formData.get('closed') === 'on';
  const input: SaveHoursOverrideInput = {date: field(formData, 'date'), openTime: closed ? null : field(formData, 'openTime'), closeTime: closed ? null : field(formData, 'closeTime')};
  await mutate('knowledge&knowledge=hours', async (source) => id ? source.updateHoursOverride(id, input) : source.createHoursOverride(input));
}

export async function deleteHoursOverride(formData: FormData): Promise<void> { assertStrictFormData(formData, ['id']); await mutate('knowledge&knowledge=hours', (source) => source.deleteHoursOverride(field(formData, 'id'))); }

export async function saveFaq(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'question', 'answer', 'language']);
  const id = field(formData, 'id');
  const input: SaveFaqInput = {question: field(formData, 'question'), answer: field(formData, 'answer'), language: field(formData, 'language') as Language, source: 'owner'};
  await mutate('knowledge&knowledge=faqs', async (source) => id ? source.updateFaq(id, input) : source.createFaq(input));
}

export async function deleteFaq(formData: FormData): Promise<void> { assertStrictFormData(formData, ['id']); await mutate('knowledge&knowledge=faqs', (source) => source.deleteFaq(field(formData, 'id'))); }

export async function savePolicy(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'title', 'content']);
  const id = field(formData, 'id');
  const input: SavePolicyInput = {title: field(formData, 'title'), content: field(formData, 'content')};
  await mutate('knowledge&knowledge=policies', async (source) => id ? source.updatePolicy(id, input) : source.createPolicy(input));
}

export async function deletePolicy(formData: FormData): Promise<void> { assertStrictFormData(formData, ['id']); await mutate('knowledge&knowledge=policies', (source) => source.deletePolicy(field(formData, 'id'))); }

export async function saveRules(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['transferPhone', 'transferStart', 'transferEnd', 'slotMinutes', 'coversPerSlot', 'seatingMinutes', 'maxParty', 'leadTimeMinutes', 'bookingWindowDays']);
  await mutate('rules', async (source) => {
    await source.updateRestaurantRules(field(formData, 'transferPhone'), {start: field(formData, 'transferStart'), end: field(formData, 'transferEnd')});
    await source.updateSlotsConfig({slotMinutes: Number(field(formData, 'slotMinutes')), coversPerSlot: Number(field(formData, 'coversPerSlot')), seatingMinutes: Number(field(formData, 'seatingMinutes')), maxParty: Number(field(formData, 'maxParty')), leadTimeMinutes: Number(field(formData, 'leadTimeMinutes')), bookingWindowDays: Number(field(formData, 'bookingWindowDays'))});
  });
}

export async function publishDraft(): Promise<void> {
  await requireActionCapability('publishAgent');
  const source = getDataSource();
  let error = '';
  try {
    const draft = (await source.listAgentVersions()).filter((row) => row.status === 'draft').sort((left, right) => right.versionNo - left.versionNo)[0];
    if (!draft) throw new Error('NO_DRAFT');
    await source.publishAgentVersion(draft.id);
  } catch (caught) { error = errorCode(caught); }
  if (error) redirect(`/agent?tab=versions&error=${error}`);
  await invalidateAfterWrite();
  redirect('/agent?tab=versions&published=1');
}

export async function restoreVersion(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id']);
  await requireActionCapability('publishAgent');
  const source = getDataSource();
  let error = '';
  try { await source.restoreAgentVersion(field(formData, 'id')); } catch (caught) { error = errorCode(caught); }
  if (error) redirect(`/agent?tab=versions&error=${error}`);
  await invalidateAfterWrite();
  redirect('/agent?tab=versions&restored=1');
}

async function mutate(tab: string, operation: (source: DataSource) => Promise<unknown>): Promise<void> {
  await requireActionCapability('publishAgent');
  const source = getDataSource();
  let error = '';
  try { await operation(source); await saveCurrentDraft(source); } catch (caught) { error = errorCode(caught); }
  if (error) redirect(`/agent?tab=${tab}&error=${error}`);
  await invalidateAfterWrite();
  redirect(`/agent?tab=${tab}&saved=1`);
}

async function saveCurrentDraft(source: DataSource): Promise<void> {
  const [agent, restaurant, menu, modifiers, hours, overrides, faqs, policies, slots, versions] = await Promise.all([source.getAgent(), getCurrentRestaurant(), source.listMenuItems(), source.listMenuModifiers(), source.listHours(), source.listHoursOverrides(), source.listFaqs(), source.listPolicies(), source.getSlotsConfig(), source.listAgentVersions()]);
  const published = versions.find((row) => row.id === agent.currentPublishedVersionId);
  const promptSections = {
    persona: `${agent.personaName} · ${agent.fillerLevel}`,
    languages: `${restaurant.primaryLanguage}: ${restaurant.enabledLanguages.join(', ')}`,
    menu: menu.map((item) => `${item.name} | ${item.description} | ${item.priceCents} | ${modifiers.filter((modifier) => modifier.menuItemId === item.id).map((modifier) => modifier.name).join(', ')}`).join('\n'),
    hours: `${hours.map((row) => `${row.weekday}:${row.openTime}-${row.closeTime}`).join(', ')}\n${overrides.map((row) => `${row.date}:${row.openTime ?? 'closed'}-${row.closeTime ?? 'closed'}`).join(', ')}`,
    faqs: faqs.map((row) => `${row.language} | ${row.question} | ${row.answer}`).join('\n'),
    policies: policies.map((row) => `${row.title} | ${row.content}`).join('\n'),
    rules: `${restaurant.transferPhone} | ${restaurant.transferHours.start}-${restaurant.transferHours.end} | ${JSON.stringify({slotMinutes: slots.slotMinutes, coversPerSlot: slots.coversPerSlot, seatingMinutes: slots.seatingMinutes, maxParty: slots.maxParty, leadTimeMinutes: slots.leadTimeMinutes, bookingWindowDays: slots.bookingWindowDays})}`
  };
  await source.saveAgentDraft(agent.id, promptSections, published?.voices, {transferStart: restaurant.transferHours.start, transferEnd: restaurant.transferHours.end, slotMinutes: slots.slotMinutes, coversPerSlot: slots.coversPerSlot, seatingMinutes: slots.seatingMinutes, maxParty: slots.maxParty, leadTimeMinutes: slots.leadTimeMinutes, bookingWindowDays: slots.bookingWindowDays});
}

function field(formData: FormData, name: string): string { const value = formData.get(name); return typeof value === 'string' ? value.trim() : ''; }
function cents(value: string): number { const amount = Number(value); return Number.isFinite(amount) ? Math.round(amount * 100) : Number.NaN; }
function errorCode(caught: unknown): string { const message = caught instanceof Error ? caught.message : ''; return knownErrors.has(message) ? message : 'UNKNOWN'; }
