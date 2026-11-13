import type {AgentVersion, AuditLog, Booking, BookingStatus, CreateFaqInput, DataSource, Faq, FeatureFlag, FeatureFlagKey, Hours, HoursOverride, Identifier, ImportJob, Language, MenuItem, MenuModifier, Message, OnboardingState, Order, OrderStatus, Policy, SaveAgentInput, SaveBookingInput, SaveFaqInput, SaveHoursInput, SaveHoursOverrideInput, SaveMenuItemInput, SaveMenuModifierInput, SaveOnboardingStateInput, SavePolicyInput, SlotsConfig, SupportSession} from '../types';
import {buildSeed, type MockSeed} from './seed';
import {checkBookingCapacity} from '../../bookings/capacity';
import {validateE164, validateKnowledgeEntry, validateTimeRange} from '../../agent/validation';

const clone = <T>(value: T): T => structuredClone(value);
const paymentMutators = new WeakMap<DataSource, (kind: 'order' | 'booking', id: string) => 'applied' | 'stale' | 'not_found'>();

export function markMockPaymentPaid(source: DataSource, kind: 'order' | 'booking', id: string): 'applied' | 'stale' | 'not_found' {
  return paymentMutators.get(source)?.(kind, id) ?? 'not_found';
}

export function getMockSeed(): MockSeed {
  return buildSeed();
}

export function createMockDataSource(clock: () => Date = () => new Date()): DataSource {
  const data = buildSeed();
  const importJobs: ImportJob[] = [];
  const featureFlags: FeatureFlag[] = [];
  const supportSessions: SupportSession[] = [];
  const adminUserId = 'admin-001';
  const find = <T extends {id: string}>(rows: T[], id: Identifier, label: string): T => {
    const row = rows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`${label} not found`);
    return row;
  };
  const now = (): string => clock().toISOString();
  const audit = (action: string, target: string, reason: string): void => {
    const timestamp = now();
    const entry: AuditLog = {id: `audit-${data.auditLogs.length + 1}`, actorId: adminUserId, action, target, reason, createdAt: timestamp, updatedAt: timestamp};
    data.auditLogs.push(entry);
  };
  const saveDraft = (agentId: Identifier, promptSections: Record<string, string>, voices: AgentVersion['voices'] = {}, rules: AgentVersion['rules'] = {}, forceNew = false): AgentVersion => {
    if (agentId !== data.agent.id) throw new Error('Agent not found');
    const existing = forceNew ? undefined : data.agentVersions.find((row) => row.status === 'draft');
    if (existing) {
      existing.promptSections = clone(promptSections);
      existing.voices = clone(voices);
      existing.rules = clone(rules);
      existing.updatedAt = now();
      return clone(existing);
    }
    const versionNo = Math.max(...data.agentVersions.map((row) => row.versionNo)) + 1;
    const row: AgentVersion = {...baseVersion(data, versionNo, now()), promptSections: clone(promptSections), voices: clone(voices), rules: clone(rules)};
    data.agentVersions.push(row);
    return clone(row);
  };

  const source: DataSource = {
    async getOnboardingState() { return clone(data.onboardingState); },
    async saveOnboardingState(input: SaveOnboardingStateInput): Promise<OnboardingState> {
      if (input.completedStep !== undefined && input.completedStep > data.onboardingState.currentStep) {
        throw new Error('ONBOARDING_STEP_ORDER');
      }
      const {completedStep, ...changes} = input;
      Object.assign(data.onboardingState, clone(changes));
      if (completedStep !== undefined && completedStep === data.onboardingState.currentStep && !data.onboardingState.completedSteps.includes(completedStep)) {
        data.onboardingState.completedSteps.push(completedStep);
        data.onboardingState.currentStep = Math.min(7, completedStep + 1) as OnboardingState['currentStep'];
      }
      return clone(data.onboardingState);
    },
    async startImportJob(url: string): Promise<ImportJob> {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new Error('IMPORT_URL_INVALID'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('IMPORT_URL_INVALID');
      const row: ImportJob = {id: `import-job-${String(importJobs.length + 1).padStart(3, '0')}`, url: parsed.toString(), status: 'queued', progress: 0};
      importJobs.push(row);
      return clone(row);
    },
    async getImportJob(id: Identifier): Promise<ImportJob> {
      const row = find(importJobs, id, 'Import job');
      const next: Record<ImportJob['status'], Pick<ImportJob, 'status' | 'progress'>> = {
        queued: {status: 'fetching', progress: 30},
        fetching: {status: 'extracting', progress: 70},
        extracting: {status: 'complete', progress: 100},
        complete: {status: 'complete', progress: 100}
      };
      Object.assign(row, next[row.status]);
      return clone(row);
    },
    async getRestaurant() { return clone(data.restaurant); },
    async getRestaurantById(id: Identifier) { if (id !== data.restaurant.id) throw new Error('Restaurant not found'); return clone(data.restaurant); },
    async updateRestaurantBasics(input: Pick<Awaited<ReturnType<DataSource['getRestaurant']>>, 'name' | 'address'>) {
      if (!input.name.trim() || !input.address.trim()) throw new Error('RESTAURANT_BASICS_REQUIRED');
      Object.assign(data.restaurant, clone(input), {updatedAt: now()});
      const adminRestaurant = data.adminRestaurants.find((row) => row.restaurantId === data.restaurant.id);
      if (adminRestaurant) adminRestaurant.name = data.restaurant.name;
      return clone(data.restaurant);
    },
    async getOrganization() { return clone(data.organization); },
    async listMemberships() { return clone(data.memberships); },
    async getNotificationPreferences() { return clone(data.notificationPreferences); },
    async updateNotificationPreferences(input) {
      data.notificationPreferences = clone(input);
      return clone(data.notificationPreferences);
    },
    async getLegalSettings() { return clone(data.legalSettings); },
    async updateLegalSettings(input) { Object.assign(data.legalSettings, input); return clone(data.legalSettings); },
    async listInvoices() { return clone(data.invoices); },
    async getViewerRole() { return data.viewerRole; },
    async listAdminRestaurants() { return clone(data.adminRestaurants); },
    async listAdminPhoneNumbers() { return [clone(data.phoneNumber)]; },
    async listAuditLogs() { return clone(data.auditLogs); },
    async getActiveSupportSession() {
      const at = clock().getTime();
      const row = supportSessions.find((session) => session.endedAt === null && Date.parse(session.startedAt) <= at && Date.parse(session.expiresAt) > at);
      return row ? clone(row) : null;
    },
    async startSupportSession(restaurantId: Identifier, reason: string) {
      reason = reason.trim();
      if (reason.length < 10) throw new Error('SUPPORT_REASON_REQUIRED');
      if (restaurantId !== data.restaurant.id) throw new Error('RESTAURANT_NOT_FOUND');
      if (await this.getActiveSupportSession()) throw new Error('SUPPORT_SESSION_ACTIVE');
      const startedAt = now();
      const row: SupportSession = {id: `support-${supportSessions.length + 1}`, adminUserId, restaurantId, reason, startedAt, expiresAt: new Date(Date.parse(startedAt) + 30 * 60 * 1000).toISOString(), endedAt: null};
      supportSessions.push(row);
      audit('support_session.started', `restaurant:${restaurantId}:session:${row.id}`, reason);
      return clone(row);
    },
    async endSupportSession(sessionId: Identifier) {
      const row = supportSessions.find((session) => session.id === sessionId && session.endedAt === null);
      if (!row) throw new Error('SUPPORT_SESSION_INACTIVE');
      row.endedAt = now();
      audit('support_session.ended', `restaurant:${row.restaurantId}:session:${row.id}`, row.reason);
      return clone(row);
    },
    async listFeatureFlags() { return clone(featureFlags); },
    async setFeatureFlag(key: FeatureFlagKey, restaurantId: Identifier | null, enabled: boolean) {
      const timestamp = now();
      let row = featureFlags.find((flag) => flag.key === key && flag.restaurantId === restaurantId);
      if (row) Object.assign(row, {enabled, updatedBy: adminUserId, updatedAt: timestamp});
      else {
        row = {id: `flag-${featureFlags.length + 1}`, key, restaurantId, enabled, updatedBy: adminUserId, updatedAt: timestamp};
        featureFlags.push(row);
      }
      const scope = restaurantId ? `restaurant:${restaurantId}` : 'global';
      audit('feature_flag.toggled', `feature-flag:${key}:${scope}`, `${enabled ? 'Enabled' : 'Disabled'} ${key} for ${scope}`);
      return clone(row);
    },
    async setPhoneKillSwitch(phoneNumberId: Identifier, enabled: boolean, reason: string) {
      reason = reason.trim();
      if (reason.length < 10) throw new Error('KILL_SWITCH_REASON_REQUIRED');
      if (phoneNumberId !== data.phoneNumber.id) throw new Error('PHONE_NUMBER_NOT_FOUND');
      data.phoneNumber.killSwitch = enabled;
      data.phoneNumber.updatedAt = now();
      audit(`phone_number.kill_switch.${enabled ? 'enabled' : 'disabled'}`, `phone-number:${phoneNumberId}`, reason);
      return clone(data.phoneNumber);
    },
    async listHours() { return clone(data.hours); },
    async createHours(input: Pick<Hours, 'weekday' | 'openTime' | 'closeTime'>): Promise<Hours> {
      validateHours(input.openTime, input.closeTime);
      if (!Number.isSafeInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) throw new Error('WEEKDAY_INVALID');
      if (data.hours.some((row) => row.weekday === input.weekday)) throw new Error('WEEKDAY_DUPLICATE');
      const timestamp = now();
      const row: Hours = {...input, id: nextId(data.hours, 'hours'), restaurantId: data.restaurant.id, createdAt: timestamp, updatedAt: timestamp};
      data.hours.push(row);
      return clone(row);
    },
    async listHoursOverrides() { return clone(data.hoursOverrides); },
    async listMenuItems() { return clone(data.menuItems); },
    async createMenuItem(input: SaveMenuItemInput): Promise<MenuItem> {
      validateMenuItem(input);
      const timestamp = now();
      const row: MenuItem = {...clone(input), id: nextId(data.menuItems, 'menu'), restaurantId: data.restaurant.id, createdAt: timestamp, updatedAt: timestamp};
      data.menuItems.push(row); return clone(row);
    },
    async updateMenuItem(id: Identifier, input: SaveMenuItemInput): Promise<MenuItem> {
      validateMenuItem(input); const row = find(data.menuItems, id, 'Menu item'); Object.assign(row, clone(input), {updatedAt: now()}); return clone(row);
    },
    async deleteMenuItem(id: Identifier): Promise<void> {
      find(data.menuItems, id, 'Menu item'); data.menuItems = data.menuItems.filter((row) => row.id !== id); data.menuModifiers = data.menuModifiers.filter((row) => row.menuItemId !== id);
    },
    async listMenuModifiers() { return clone(data.menuModifiers); },
    async createMenuModifier(input: SaveMenuModifierInput): Promise<MenuModifier> {
      validateModifier(input, data); const timestamp = now(); const row: MenuModifier = {...clone(input), id: nextId(data.menuModifiers, 'modifier'), createdAt: timestamp, updatedAt: timestamp}; data.menuModifiers.push(row); return clone(row);
    },
    async updateMenuModifier(id: Identifier, input: SaveMenuModifierInput): Promise<MenuModifier> {
      validateModifier(input, data); const row = find(data.menuModifiers, id, 'Menu modifier'); Object.assign(row, clone(input), {updatedAt: now()}); return clone(row);
    },
    async deleteMenuModifier(id: Identifier): Promise<void> { find(data.menuModifiers, id, 'Menu modifier'); data.menuModifiers = data.menuModifiers.filter((row) => row.id !== id); },
    async listFaqs() { return clone(data.faqs); },
    async createFaq(input: CreateFaqInput): Promise<Faq> {
      validateFaq(input);
      const timestamp = now();
      const row: Faq = {...input, id: `faq-${String(data.faqs.length + 1).padStart(3, '0')}`, restaurantId: data.restaurant.id, createdAt: timestamp, updatedAt: timestamp};
      data.faqs.push(row);
      return clone(row);
    },
    async updateFaq(id: Identifier, input: SaveFaqInput): Promise<Faq> { validateFaq(input); const row = find(data.faqs, id, 'FAQ'); Object.assign(row, clone(input), {updatedAt: now()}); return clone(row); },
    async deleteFaq(id: Identifier): Promise<void> { find(data.faqs, id, 'FAQ'); data.faqs = data.faqs.filter((row) => row.id !== id); },
    async listPolicies() { return clone(data.policies); },
    async createPolicy(input: SavePolicyInput): Promise<Policy> { validatePolicy(input); const timestamp = now(); const row: Policy = {...clone(input), id: nextId(data.policies, 'policy'), agentId: data.agent.id, createdAt: timestamp, updatedAt: timestamp}; data.policies.push(row); return clone(row); },
    async updatePolicy(id: Identifier, input: SavePolicyInput): Promise<Policy> { validatePolicy(input); const row = find(data.policies, id, 'Policy'); Object.assign(row, clone(input), {updatedAt: now()}); return clone(row); },
    async deletePolicy(id: Identifier): Promise<void> { find(data.policies, id, 'Policy'); data.policies = data.policies.filter((row) => row.id !== id); },
    async updateHours(id: Identifier, input: SaveHoursInput): Promise<Hours> { validateHours(input.openTime, input.closeTime); const row = find(data.hours, id, 'Hours'); Object.assign(row, input, {updatedAt: now()}); return clone(row); },
    async createHoursOverride(input: SaveHoursOverrideInput): Promise<HoursOverride> { validateOverride(input); if (data.hoursOverrides.some((row) => row.date === input.date)) throw new Error('DATE_DUPLICATE'); const timestamp = now(); const row: HoursOverride = {...clone(input), id: nextId(data.hoursOverrides, 'override'), restaurantId: data.restaurant.id, createdAt: timestamp, updatedAt: timestamp}; data.hoursOverrides.push(row); return clone(row); },
    async updateHoursOverride(id: Identifier, input: SaveHoursOverrideInput): Promise<HoursOverride> { validateOverride(input); if (data.hoursOverrides.some((row) => row.id !== id && row.date === input.date)) throw new Error('DATE_DUPLICATE'); const row = find(data.hoursOverrides, id, 'Hours override'); Object.assign(row, clone(input), {updatedAt: now()}); return clone(row); },
    async deleteHoursOverride(id: Identifier): Promise<void> { find(data.hoursOverrides, id, 'Hours override'); data.hoursOverrides = data.hoursOverrides.filter((row) => row.id !== id); },
    async getAgent() { return clone(data.agent); },
    async updateAgent(id: Identifier, input: SaveAgentInput) { const row = id === data.agent.id ? data.agent : undefined; if (!row) throw new Error('Agent not found'); if (!input.personaName.trim()) throw new Error('PERSONA_REQUIRED'); Object.assign(row, clone(input), {updatedAt: now()}); return clone(row); },
    async updateRestaurantLanguages(enabledLanguages: Language[], primaryLanguage: Language) { if (!enabledLanguages.length) throw new Error('LANGUAGE_REQUIRED'); if (!enabledLanguages.includes(primaryLanguage)) throw new Error('PRIMARY_LANGUAGE_DISABLED'); data.restaurant.enabledLanguages = [...new Set(enabledLanguages)]; data.restaurant.primaryLanguage = primaryLanguage; data.restaurant.updatedAt = now(); return clone(data.restaurant); },
    async updateRestaurantRules(transferPhone: string, transferHours: Record<string, string>) { const daily = transferHours.daily?.split('-') ?? []; const start = transferHours.start ?? daily[0] ?? ''; const end = transferHours.end ?? daily[1] ?? ''; if (!validateE164(transferPhone)) throw new Error('PHONE_INVALID'); if (!validateTimeRange(start, end)) throw new Error('TRANSFER_HOURS_INVALID'); data.restaurant.transferPhone = transferPhone; data.restaurant.transferHours = clone(transferHours); data.restaurant.updatedAt = now(); return clone(data.restaurant); },
    async updateSlotsConfig(input: Pick<SlotsConfig, 'slotMinutes' | 'coversPerSlot' | 'seatingMinutes' | 'maxParty' | 'leadTimeMinutes' | 'bookingWindowDays'>) { const positive = [input.slotMinutes, input.coversPerSlot, input.seatingMinutes, input.maxParty, input.bookingWindowDays]; if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0) || !Number.isSafeInteger(input.leadTimeMinutes) || input.leadTimeMinutes < 0) throw new Error('BOOKING_RULES_INVALID'); Object.assign(data.slotsConfig, input, {updatedAt: now()}); return clone(data.slotsConfig); },
    async setAgentEnabled(enabled: boolean) { data.agent.enabled = enabled; data.agent.updatedAt = now(); return clone(data.agent); },
    async listAgentVersions() { return clone(data.agentVersions); },
    async getPhoneNumber() { return clone(data.phoneNumber); },
    async listCalls() { return clone(data.calls); },
    async getActiveCall() { return clone(data.activeCall); },
    async listCallTurns(callId) { return clone(data.callTurns.filter((row) => row.callId === callId)); },
    async listCallMetrics(callId) { return clone(data.callMetrics.filter((row) => row.callId === callId)); },
    async getSlotsConfig() { return clone(data.slotsConfig); },
    async listBookings() { return clone(data.bookings); },
    async createBooking(input: SaveBookingInput): Promise<Booking> {
      validateBooking(input, data, clock());
      const timestamp = now();
      const row: Booking = {...input, id: `booking-${String(data.bookings.length + 1).padStart(3, '0')}`, restaurantId: data.restaurant.id, callId: null, status: 'confirmed', paidStatus: 'unpaid', source: 'owner', createdAt: timestamp, updatedAt: timestamp};
      data.bookings.push(row);
      return clone(row);
    },
    async updateBooking(id: Identifier, input: SaveBookingInput): Promise<Booking> {
      const row = find(data.bookings, id, 'Booking');
      validateBooking(input, data, clock(), id);
      Object.assign(row, input, {updatedAt: now()});
      return clone(row);
    },
    async listOrders() { return clone(data.orders); },
    async listOrderItems(orderId) { return clone(data.orderItems.filter((row) => !orderId || row.orderId === orderId)); },
    async listMessages() { return clone(data.messages); },
    async getUsage() { return clone(data.usage); },
    async updateBookingStatus(id: Identifier, status: BookingStatus): Promise<Booking> {
      const row = find(data.bookings, id, 'Booking'); row.status = status; row.updatedAt = now(); return clone(row);
    },
    async updateOrderStatus(id: Identifier, status: OrderStatus): Promise<Order> {
      const row = find(data.orders, id, 'Order'); row.status = status; row.updatedAt = now(); return clone(row);
    },
    async saveAgentDraft(agentId: Identifier, promptSections: Record<string, string>, voices?: AgentVersion['voices'], rules?: AgentVersion['rules']): Promise<AgentVersion> {
      return saveDraft(agentId, promptSections, voices, rules);
    },
    async publishAgentVersion(versionId: Identifier): Promise<AgentVersion> {
      const row = find(data.agentVersions, versionId, 'Agent version');
      for (const version of data.agentVersions) if (version.status === 'published') version.status = 'archived';
      row.status = 'published'; row.publishedAt = now(); row.publishedBy = 'owner-001'; row.updatedAt = now(); data.agent.currentPublishedVersionId = row.id; return clone(row);
    },
    async restoreAgentVersion(versionId: Identifier): Promise<AgentVersion> {
      const source = find(data.agentVersions, versionId, 'Agent version');
      for (const version of data.agentVersions) {
        if (version.status === 'draft') { version.status = 'archived'; version.updatedAt = now(); }
      }
      return saveDraft(source.agentId, source.promptSections, source.voices, source.rules, true);
    },
    async markMessageHandled(id: Identifier, handled: boolean): Promise<Message> {
      const row = find(data.messages, id, 'Message'); row.handled = handled; row.updatedAt = now(); return clone(row);
    }
  };
  paymentMutators.set(source, (kind, id) => {
    const rows = kind === 'order' ? data.orders : data.bookings;
    const target = rows.find((row) => row.id === id && row.restaurantId === data.restaurant.id);
    if (!target) return 'not_found';
    if (target.paidStatus === 'paid') return 'stale';
    target.paidStatus = 'paid';
    target.updatedAt = now();
    return 'applied';
  });
  return source;
}

function validateBooking(input: SaveBookingInput, data: MockSeed, currentTime: Date, excludeId?: Identifier): void {
  if (!input.name.trim()) throw new Error('NAME_REQUIRED');
  if (!/^\+[1-9]\d{7,14}$/.test(input.phoneE164)) throw new Error('PHONE_INVALID');
  if (!Number.isSafeInteger(input.partySize) || input.partySize <= 0) throw new Error('PARTY_SIZE_INVALID');
  if (input.partySize > data.slotsConfig.maxParty) throw new Error('MAX_PARTY');
  const startsAt = new Date(input.startsAt);
  if (!Number.isFinite(startsAt.getTime())) throw new Error('START_INVALID');
  if (startsAt.getTime() - currentTime.getTime() < data.slotsConfig.leadTimeMinutes * 60_000) throw new Error('LEAD_TIME');
  const currentDate = dateKey(currentTime, data.restaurant.timezone);
  const bookingDate = dateKey(startsAt, data.restaurant.timezone);
  if (dayOrdinal(bookingDate) - dayOrdinal(currentDate) > data.slotsConfig.bookingWindowDays) throw new Error('BOOKING_WINDOW');
  if (data.hoursOverrides.some((override) => override.date === bookingDate && (override.openTime === null || override.closeTime === null))) throw new Error('BLACKOUT_DATE');
  const capacity = checkBookingCapacity(data.bookings.filter((booking) => booking.id !== excludeId), input, data.slotsConfig);
  if (!capacity.available) throw new Error('CAPACITY');
}

function dateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function dayOrdinal(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / 86_400_000;
}

function baseVersion(data: MockSeed, versionNo: number, timestamp: string): AgentVersion {
  return {id: `agent-version-${versionNo}`, createdAt: timestamp, updatedAt: timestamp, agentId: data.agent.id, versionNo, status: 'draft', promptSections: {}, voices: {}, rules: {}, publishedAt: null, publishedBy: null};
}

function nextId(rows: Array<{id: string}>, prefix: string): string {
  const marker = `${prefix}-`;
  const next = rows.reduce((maximum, row) => row.id.startsWith(marker) ? Math.max(maximum, Number(row.id.slice(marker.length)) || 0) : maximum, 0) + 1;
  return `${marker}${String(next).padStart(3, '0')}`;
}
function validateMenuItem(input: SaveMenuItemInput): void { const errors = validateKnowledgeEntry({title: input.name, content: input.category, priceCents: input.priceCents}); if (errors.length) throw new Error(errors[0]); }
function validateModifier(input: SaveMenuModifierInput, data: MockSeed): void { if (!data.menuItems.some((row) => row.id === input.menuItemId)) throw new Error('MENU_ITEM_NOT_FOUND'); if (!input.name.trim()) throw new Error('TITLE_REQUIRED'); if (!Number.isSafeInteger(input.priceDeltaCents) || !Number.isSafeInteger(input.maxSelect) || input.maxSelect <= 0) throw new Error('PRICE_INVALID'); }
function validateFaq(input: SaveFaqInput): void { const errors = validateKnowledgeEntry({title: input.question, content: input.answer}); if (errors.length) throw new Error(errors[0]); }
function validatePolicy(input: SavePolicyInput): void { const errors = validateKnowledgeEntry({title: input.title, content: input.content}); if (errors.length) throw new Error(errors[0]); }
function validateHours(openTime: string, closeTime: string): void { if (!validateTimeRange(openTime, closeTime)) throw new Error('HOURS_INVALID'); }
function validateOverride(input: SaveHoursOverrideInput): void { if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error('DATE_INVALID'); if (input.openTime === null && input.closeTime === null) return; if (input.openTime === null || input.closeTime === null) throw new Error('HOURS_INVALID'); validateHours(input.openTime, input.closeTime); }
