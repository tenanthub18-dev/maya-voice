import {expect, it} from 'vitest';
import type {DataSource} from '@/lib/data/types';

// Shared scope is limited to PRD section 7-backed behavior. UI-only mock features
// without a persistent PRD schema (onboarding/import/settings/admin aggregates)
// are intentionally covered only by their implementation-specific tests.
export function dataSourceContract(createSource: () => DataSource): void {
  it('reads the restaurant and its tenant-owned records', async () => {
    const source = createSource();
    const restaurant = await source.getRestaurant();

    expect(restaurant.name).not.toBe('');
    expect((await source.listHours()).every((row) => row.restaurantId === restaurant.id)).toBe(true);
    expect((await source.listFaqs()).every((row) => row.restaurantId === restaurant.id)).toBe(true);
  });

  it('persists FAQ create, update, and delete', async () => {
    const source = createSource();
    const created = await source.createFaq({
      question: 'Is the patio open?',
      answer: 'The patio is seasonal.',
      language: 'en',
      source: 'owner'
    });
    const updated = await source.updateFaq(created.id, {...created, answer: 'The patio opens in May.'});

    expect(updated.answer).toBe('The patio opens in May.');
    expect((await source.listFaqs()).some((row) => row.id === created.id)).toBe(true);

    await source.deleteFaq(created.id);
    expect((await source.listFaqs()).some((row) => row.id === created.id)).toBe(false);
  });

  it('persists operational status mutations', async () => {
    const source = createSource();
    const booking = (await source.listBookings())[0];
    const order = (await source.listOrders())[0];
    const message = (await source.listMessages())[0];

    expect((await source.updateBookingStatus(booking.id, 'cancelled')).status).toBe('cancelled');
    expect((await source.updateOrderStatus(order.id, 'ready')).status).toBe('ready');
    expect((await source.markMessageHandled(message.id, true)).handled).toBe(true);
  });

  it('persists agent and restaurant settings', async () => {
    const source = createSource();
    const agent = await source.getAgent();

    expect(await source.setAgentEnabled(false)).toMatchObject({id: agent.id, enabled: false});
    expect(await source.updateRestaurantLanguages(['en', 'fr-CA'], 'fr-CA')).toMatchObject({
      enabledLanguages: ['en', 'fr-CA'],
      primaryLanguage: 'fr-CA'
    });
  });

  it('reads calls, menu, slots, and version history', async () => {
    const source = createSource();

    expect((await source.listCalls()).length).toBeGreaterThan(0);
    expect((await source.listCallTurns((await source.listCalls())[0].id)).length).toBeGreaterThan(0);
    expect((await source.listCallMetrics((await source.listCalls())[0].id)).length).toBeGreaterThan(0);
    expect((await source.listMenuItems()).length).toBeGreaterThan(0);
    expect(await source.getSlotsConfig()).toMatchObject({slotMinutes: 15, coversPerSlot: 16});
    expect((await source.listAgentVersions()).some((version) => version.status === 'published')).toBe(true);
  });

  it('persists menu items and modifiers', async () => {
    const source = createSource();
    const item = await source.createMenuItem({
      name: 'Dal', description: 'Slow-cooked lentils', priceCents: 1295,
      category: 'Mains', dietaryTags: ['vegan'], available: true
    });
    const modifier = await source.createMenuModifier({
      menuItemId: item.id, name: 'Extra rice', priceDeltaCents: 250, required: false, maxSelect: 2
    });

    expect(await source.updateMenuItem(item.id, {...item, name: 'House dal'})).toMatchObject({name: 'House dal'});
    expect(await source.updateMenuModifier(modifier.id, {...modifier, maxSelect: 3})).toMatchObject({maxSelect: 3});
    await source.deleteMenuModifier(modifier.id);
    await source.deleteMenuItem(item.id);
    expect((await source.listMenuItems()).some((row) => row.id === item.id)).toBe(false);
  });

  it('creates a capacity-checked booking through the implementation boundary', async () => {
    const source = createSource();
    const booking = await source.createBooking({
      name: 'Contract guest', phoneE164: '+14165550111', partySize: 2,
      startsAt: '2026-11-10T22:00:00.000Z', notes: 'Window'
    });

    expect(booking).toMatchObject({name: 'Contract guest', status: 'confirmed', source: 'owner'});
    expect((await source.listBookings()).some((row) => row.id === booking.id)).toBe(true);
  });

  it('saves and publishes an agent version', async () => {
    const source = createSource();
    const agent = await source.getAgent();
    const draft = await source.saveAgentDraft(agent.id, {greeting: 'Welcome'});
    const published = await source.publishAgentVersion(draft.id);
    const restored = await source.restoreAgentVersion(published.id);

    expect(published).toMatchObject({id: draft.id, status: 'published'});
    expect(restored).toMatchObject({status: 'draft', promptSections: {greeting: 'Welcome'}});
    expect(restored.id).not.toBe(published.id);
    expect((await source.listAgentVersions()).filter((row) => row.status === 'published')).toHaveLength(1);
  });
}
