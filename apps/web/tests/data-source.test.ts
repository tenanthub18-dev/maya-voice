import {beforeEach, describe, expect, it} from 'vitest';
import {createMockDataSource, getMockSeed} from '@/lib/data/mock';
import {buildHomeStats, groupOrdersByStatus} from '@/lib/dashboard';
import {checkEnv} from '../../../scripts/check-env';
import {getDataSource, isDemoData} from '@/lib/data';

describe('mock DataSource contract', () => {
  beforeEach(() => {
    delete process.env.DATA_SOURCE;
  });

  it('keeps every relation attached to an existing parent', async () => {
    const source = createMockDataSource();
    const restaurant = await source.getRestaurant();
    const calls = await source.listCalls();
    const callIds = new Set(calls.map((call) => call.id));

    expect((await source.listHours()).every((row) => row.restaurantId === restaurant.id)).toBe(true);
    expect((await source.listBookings()).every((row) => row.restaurantId === restaurant.id && (!row.callId || callIds.has(row.callId)))).toBe(true);
    expect((await source.listOrders()).every((row) => row.restaurantId === restaurant.id && (!row.callId || callIds.has(row.callId)))).toBe(true);
    expect((await source.listMessages()).every((row) => row.restaurantId === restaurant.id && (!row.callId || callIds.has(row.callId)))).toBe(true);

    for (const call of calls) {
      expect((await source.listCallTurns(call.id)).every((turn) => turn.callId === call.id)).toBe(true);
      expect((await source.listCallMetrics(call.id)).every((metric) => metric.callId === call.id)).toBe(true);
    }
  });

  it('stores monetary values as integer cents or micros', () => {
    const seed = getMockSeed();
    const amounts = [
      ...seed.menuItems.map((item) => item.priceCents),
      ...seed.menuModifiers.map((item) => item.priceDeltaCents),
      ...seed.orders.flatMap((order) => [order.subtotalCents, order.taxCents, order.totalCents]),
      ...seed.orderItems.map((item) => item.priceCents),
      ...seed.calls.flatMap((call) => Object.values(call.costMicros))
    ];

    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.every(Number.isInteger)).toBe(true);
  });

  it('contains transcript turns in all six launch languages', () => {
    const languages = new Set(getMockSeed().callTurns.map((turn) => turn.language));
    expect([...languages].sort()).toEqual(['en', 'en-IN', 'fr-CA', 'hi', 'ar', 'pa', 'te', 'ur'].sort());
  });

  it('builds the same deterministic seed every time', () => {
    expect(getMockSeed()).toEqual(getMockSeed());
    expect(getMockSeed().calls).toHaveLength(40);
  });

  it('persists onboarding form data and advances completed steps in order', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));

    expect(await source.getOnboardingState()).toMatchObject({currentStep: 1, completedSteps: []});

    await source.saveOnboardingState({
      basics: {
        name: 'Harbour Table',
        address: '88 Queens Quay W, Toronto, ON',
        websiteUrl: 'https://harbourtable.example',
        cuisine: 'South Asian'
      },
      completedStep: 1
    });
    const resumed = await source.getOnboardingState();

    expect(resumed).toMatchObject({
      currentStep: 2,
      completedSteps: [1],
      basics: {websiteUrl: 'https://harbourtable.example', cuisine: 'South Asian'}
    });
  });

  it('keeps edited onboarding basics consistent with the restaurant record', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));

    await source.updateRestaurantBasics({name: 'Harbour Table East', address: '10 Front St E, Toronto, ON'});

    expect(await source.getRestaurant()).toMatchObject({
      name: 'Harbour Table East',
      address: '10 Front St E, Toronto, ON',
      updatedAt: '2026-10-27T12:00:00.000Z'
    });
  });

  it('rejects onboarding completion that skips the current step', async () => {
    const source = createMockDataSource();

    await expect(source.saveOnboardingState({completedStep: 2})).rejects.toThrow('ONBOARDING_STEP_ORDER');
    expect(await source.getOnboardingState()).toMatchObject({currentStep: 1, completedSteps: []});
  });

  it('allows an already-completed step to be edited without regressing progress', async () => {
    const source = createMockDataSource();
    await source.saveOnboardingState({completedStep: 1});
    await source.saveOnboardingState({completedStep: 2});

    const edited = await source.saveOnboardingState({
      basics: {...(await source.getOnboardingState()).basics, cuisine: 'Punjabi'},
      completedStep: 1
    });

    expect(edited).toMatchObject({currentStep: 3, completedSteps: [1, 2], basics: {cuisine: 'Punjabi'}});
  });

  it('advances website imports through deterministic progress states', async () => {
    const source = createMockDataSource();
    const started = await source.startImportJob('https://harbourtable.example');

    expect(started).toMatchObject({id: 'import-job-001', status: 'queued', progress: 0});
    expect(await source.getImportJob(started.id)).toMatchObject({status: 'fetching', progress: 30});
    expect(await source.getImportJob(started.id)).toMatchObject({status: 'extracting', progress: 70});
    expect(await source.getImportJob(started.id)).toMatchObject({status: 'complete', progress: 100});
    expect(await source.getImportJob(started.id)).toMatchObject({status: 'complete', progress: 100});
  });

  it('persists the required in-memory mutations', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const booking = (await source.listBookings())[0];
    const message = (await source.listMessages())[0];
    const agent = await source.getAgent();

    await source.updateBookingStatus(booking.id, 'cancelled');
    await source.markMessageHandled(message.id, true);
    const draft = await source.saveAgentDraft(agent.id, {greeting: 'Welcome'});
    const published = await source.publishAgentVersion(draft.id);
    const restored = await source.restoreAgentVersion(published.id);
    const disabled = await source.setAgentEnabled(false);
    const taught = await source.createFaq({question: 'Do you have a patio?', answer: 'The patio opens in May.', language: 'en', source: 'teach'});
    const createdBooking = await source.createBooking({name: 'New guest', phoneE164: '+14165550111', partySize: 4, startsAt: '2026-11-10T22:00:00.000Z', notes: 'Window'});
    const editedBooking = await source.updateBooking(createdBooking.id, {...createdBooking, name: 'Updated guest', partySize: 5});
    const order = (await source.listOrders())[0];
    const movedOrder = await source.updateOrderStatus(order.id, 'ready');

    expect((await source.listBookings()).find((row) => row.id === booking.id)?.status).toBe('cancelled');
    expect((await source.listMessages()).find((row) => row.id === message.id)?.handled).toBe(true);
    expect(published.status).toBe('published');
    expect(restored.status).toBe('draft');
    expect(restored.versionNo).toBeGreaterThan(published.versionNo);
    expect(disabled.enabled).toBe(false);
    expect((await source.getAgent()).enabled).toBe(false);
    expect(taught.source).toBe('teach');
    expect((await source.listFaqs()).at(-1)?.answer).toBe('The patio opens in May.');
    expect(editedBooking.name).toBe('Updated guest');
    expect(editedBooking.partySize).toBe(5);
    expect(movedOrder.status).toBe('ready');
    expect((await source.listOrders()).find((row) => row.id === order.id)?.status).toBe('ready');
  });

  it('models audited admin support sessions, flags, and number kill switches', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const restaurant = await source.getRestaurant();
    const session = await source.startSupportSession(restaurant.id, 'Investigating a reported call issue');

    expect(session).toMatchObject({restaurantId: restaurant.id, reason: 'Investigating a reported call issue', endedAt: null});
    expect(Date.parse(session.expiresAt) - Date.parse(session.startedAt)).toBe(30 * 60 * 1000);
    await source.setFeatureFlag('diner_payments', null, true);
    await source.setFeatureFlag('diner_payments', restaurant.id, false);
    expect(await source.listFeatureFlags()).toMatchObject([
      {key: 'diner_payments', restaurantId: null, enabled: true},
      {key: 'diner_payments', restaurantId: restaurant.id, enabled: false},
    ]);
    const phone = await source.getPhoneNumber();
    expect(phone).not.toBeNull();
    await source.setPhoneKillSwitch(phone!.id, true, 'Suspected abusive traffic on this number');
    expect(await source.getPhoneNumber()).toMatchObject({killSwitch: true});
    await source.endSupportSession(session.id);
    expect(await source.getActiveSupportSession()).toBeNull();
    expect((await source.listAuditLogs()).map((entry) => entry.action)).toEqual([
      'support_session.started',
      'feature_flag.toggled',
      'feature_flag.toggled',
      'phone_number.kill_switch.enabled',
      'support_session.ended',
    ]);
  });

  it('persists agent-builder CRUD through the DataSource contract', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const restaurant = await source.getRestaurant();
    const agent = await source.getAgent();
    const menuItem = await source.createMenuItem({name: 'Dal', description: 'Lentils', priceCents: 1295, category: 'Mains', dietaryTags: ['vegan'], available: true});
    const modifier = await source.createMenuModifier({menuItemId: menuItem.id, name: 'Extra rice', priceDeltaCents: 250, required: false, maxSelect: 2});
    const faq = await source.createFaq({question: 'Do you deliver?', answer: 'Pickup only.', language: 'en', source: 'owner'});
    const policy = await source.createPolicy({title: 'Outside food', content: 'Not permitted.'});
    const override = await source.createHoursOverride({date: '2026-12-31', openTime: '11:00', closeTime: '18:00'});

    await source.updateMenuItem(menuItem.id, {...menuItem, name: 'House dal'});
    await source.updateMenuModifier(modifier.id, {...modifier, maxSelect: 3});
    await source.updateFaq(faq.id, {...faq, answer: 'Pickup and delivery.'});
    await source.updatePolicy(policy.id, {...policy, content: 'Ask a manager.'});
    await source.updateHours((await source.listHours())[0].id, {openTime: '12:00', closeTime: '21:00'});
    await source.updateHoursOverride(override.id, {...override, closeTime: '19:00'});
    await source.updateAgent(agent.id, {personaName: 'Asha', fillerLevel: 'natural'});
    await source.updateRestaurantLanguages(['en', 'fr-CA'], 'fr-CA');
    await source.updateRestaurantRules('+15145550123', {start: '09:00', end: '17:00'});
    await source.updateSlotsConfig({slotMinutes: 30, coversPerSlot: 20, seatingMinutes: 90, maxParty: 10, leadTimeMinutes: 120, bookingWindowDays: 60});

    expect((await source.listMenuItems()).find((row) => row.id === menuItem.id)?.name).toBe('House dal');
    expect((await source.listMenuModifiers()).find((row) => row.id === modifier.id)?.maxSelect).toBe(3);
    expect((await source.listFaqs()).find((row) => row.id === faq.id)?.answer).toBe('Pickup and delivery.');
    expect((await source.listPolicies()).find((row) => row.id === policy.id)?.content).toBe('Ask a manager.');
    expect((await source.listHoursOverrides()).find((row) => row.id === override.id)?.closeTime).toBe('19:00');
    expect(await source.getAgent()).toMatchObject({personaName: 'Asha', fillerLevel: 'natural'});
    expect(await source.getRestaurant()).toMatchObject({enabledLanguages: ['en', 'fr-CA'], primaryLanguage: 'fr-CA', transferPhone: '+15145550123', transferHours: {start: '09:00', end: '17:00'}});
    expect(await source.getSlotsConfig()).toMatchObject({slotMinutes: 30, coversPerSlot: 20, maxParty: 10});

    await source.deleteMenuModifier(modifier.id);
    await source.deleteMenuItem(menuItem.id);
    await source.deleteFaq(faq.id);
    await source.deletePolicy(policy.id);
    await source.deleteHoursOverride(override.id);
    expect((await source.listMenuItems()).some((row) => row.id === menuItem.id)).toBe(false);
    expect((await source.listMenuModifiers()).some((row) => row.id === modifier.id)).toBe(false);
    expect((await source.listFaqs()).some((row) => row.id === faq.id)).toBe(false);
    expect((await source.listPolicies()).some((row) => row.id === policy.id)).toBe(false);
    expect((await source.listHoursOverrides()).some((row) => row.id === override.id)).toBe(false);
    expect(restaurant.id).toBe((await source.getRestaurant()).id);
  });

  it('keeps deterministic CRUD identifiers unique after deleting an earlier row', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const first = await source.createPolicy({title: 'First', content: 'First policy'});
    const second = await source.createPolicy({title: 'Second', content: 'Second policy'});
    await source.deletePolicy(first.id);
    const third = await source.createPolicy({title: 'Third', content: 'Third policy'});

    expect(third.id).not.toBe(second.id);
    expect(new Set((await source.listPolicies()).map((row) => row.id)).size).toBe((await source.listPolicies()).length);
  });

  it('publishes atomically and restores all version fields into a new draft', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const agent = await source.getAgent();
    const previousPublishedId = agent.currentPublishedVersionId;
    const draft = await source.saveAgentDraft(agent.id, {greeting: 'Bienvenue', policies: 'Be kind'}, {en: 'voice-en'}, {takeout: false});
    const published = await source.publishAgentVersion(draft.id);
    const versions = await source.listAgentVersions();

    expect(published.status).toBe('published');
    expect((await source.getAgent()).currentPublishedVersionId).toBe(draft.id);
    expect(versions.filter((row) => row.status === 'published')).toHaveLength(1);
    expect(versions.find((row) => row.id === previousPublishedId)?.status).toBe('archived');

    const beforeFailedPublish = await source.listAgentVersions();
    await expect(source.publishAgentVersion('missing')).rejects.toThrow('Agent version not found');
    expect(await source.listAgentVersions()).toEqual(beforeFailedPublish);

    const displacedDraft = await source.saveAgentDraft(agent.id, {greeting: 'Unpublished edit'});
    const restored = await source.restoreAgentVersion(published.id);
    expect(restored).toMatchObject({
      status: 'draft',
      promptSections: {greeting: 'Bienvenue', policies: 'Be kind'},
      voices: {en: 'voice-en'},
      rules: {takeout: false}
    });
    expect(restored.id).not.toBe(published.id);
    expect(restored.versionNo).toBeGreaterThan(published.versionNo);
    expect((await source.listAgentVersions()).filter((row) => row.status === 'draft')).toHaveLength(1);
    expect((await source.listAgentVersions()).find((row) => row.id === displacedDraft.id)?.status).toBe('archived');
  });

  it('exposes deterministic slot configuration', async () => {
    expect(await createMockDataSource().getSlotsConfig()).toMatchObject({
      slotMinutes: 15,
      coversPerSlot: 16,
      seatingMinutes: 90,
      maxParty: 8,
      leadTimeMinutes: 60,
      bookingWindowDays: 90
    });
  });

  it('enforces max party, lead time, booking window and blackout dates', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const base = {name: 'Guest', phoneE164: '+14165550111', partySize: 4, startsAt: '2026-10-28T22:00:00.000Z', notes: ''};

    await expect(source.createBooking({...base, partySize: 9})).rejects.toThrow('MAX_PARTY');
    await expect(source.createBooking({...base, startsAt: '2026-10-27T12:30:00.000Z'})).rejects.toThrow('LEAD_TIME');
    await expect(source.createBooking({...base, startsAt: '2027-02-01T22:00:00.000Z'})).rejects.toThrow('BOOKING_WINDOW');
    await expect(source.createBooking({...base, startsAt: '2026-12-25T22:00:00.000Z'})).rejects.toThrow('BLACKOUT_DATE');
  });

  it('prevents sequential concurrent-style writes from exceeding slot capacity', async () => {
    const source = createMockDataSource(() => new Date('2026-10-27T12:00:00.000Z'));
    const base = {name: 'Guest', phoneE164: '+14165550111', partySize: 8, startsAt: '2026-11-10T22:00:00.000Z', notes: ''};

    await source.createBooking(base);
    await source.createBooking({...base, name: 'Second guest'});
    await expect(source.createBooking({...base, name: 'Third guest'})).rejects.toThrow('CAPACITY');
  });

  it('reports one active call explicitly for the live banner', async () => {
    expect(await createMockDataSource().getActiveCall()).toEqual({
      id: 'call-active-001', language: 'fr-CA', durationSeconds: 94
    });
  });

  it('exposes deterministic phone, settings and platform-admin records', async () => {
    const source = createMockDataSource();

    expect(await source.getOrganization()).toMatchObject({plan: 'growth', spendCapCents: 20_000, includedMinutes: 500});
    expect(await source.getPhoneNumber()).toMatchObject({status: 'active', forwardingVerifiedAt: null});
    expect(await source.listMemberships()).toEqual([
      expect.objectContaining({name: 'Avery Singh', role: 'owner'}),
      expect.objectContaining({name: 'Camille Roy', role: 'staff'})
    ]);
    expect(await source.getNotificationPreferences()).toEqual({messageTaken: true, missedTransfer: true, flaggedCall: true, lowBalance: true, dailyDigest: false});
    expect(await source.getLegalSettings()).toMatchObject({legalReviewRequired: true, privacyPolicyUrl: 'https://example.com/privacy'});
    expect(await source.listInvoices()).toEqual([]);
    expect(await source.getViewerRole()).toBe('platform-admin');
    expect(await source.listAdminRestaurants()).toEqual([
      expect.objectContaining({restaurantId: '11111111-1111-4111-8111-111111111111', calls: 40})
    ]);
    expect(await source.listAuditLogs()).toEqual([]);
  });
});

describe('dashboard view logic', () => {
  it('derives today totals from source records', async () => {
    const source = createMockDataSource();
    expect(buildHomeStats(await source.listCalls(), await source.listBookings(), await source.listOrders(), await source.listMessages(), '2026-10-27')).toEqual({
      calls: 3,
      bookings: 4,
      orders: 8,
      messages: 4
    });
  });

  it('groups order tickets without losing rows', async () => {
    const orders = await createMockDataSource().listOrders();
    const groups = groupOrdersByStatus(orders);
    expect(groups.new.length + groups['in-progress'].length + groups.ready.length).toBe(orders.length);
  });
});

describe('environment selection', () => {
  it('keeps data and provider keys optional in mock mode but requires auth configuration live', () => {
    const missing = checkEnv({DATA_SOURCE: undefined});
    expect(missing).not.toContain('DATA_SOURCE');
    expect(missing).not.toContain('SUPABASE_URL');
    expect(missing).not.toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
    const liveMissing = checkEnv({INTEGRATIONS_MODE: 'live'});
    expect(liveMissing).toContain('SUPABASE_URL');
    expect(liveMissing).toContain('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  });

  it('defaults to demo data and selects Supabase explicitly', () => {
    delete process.env.DATA_SOURCE;
    expect(isDemoData()).toBe(true);
    expect(getDataSource()).toBeDefined();
    process.env.DATA_SOURCE = 'supabase';
    expect(isDemoData()).toBe(false);
    expect(getDataSource()).toBeDefined();
    delete process.env.DATA_SOURCE;
  });
});
