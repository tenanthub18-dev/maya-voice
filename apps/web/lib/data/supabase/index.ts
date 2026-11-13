import type {
  ActiveCall, Agent, AgentVersion, Booking, BookingStatus, Call, CallMetric, CallTurn,
  AdminRestaurantUsage, AuditLog, CreateFaqInput, DataSource, Faq, FeatureFlag, FeatureFlagKey, Hours, HoursOverride, Identifier, Language, MenuItem,
  Invoice, LegalSettings, MenuModifier, Message, Order, OrderItem, OrderStatus, PhoneNumber, Restaurant, SaveBookingInput,
  SaveFaqInput, SaveHoursInput, SaveHoursOverrideInput, SaveMenuItemInput,
  SaveMenuModifierInput, SlotsConfig, SupportSession, ViewerRole
} from '../types';

export interface SupabaseResultLike {
  data: unknown;
  error: {message: string; code?: string; details?: string; hint?: string} | null;
}

export type SupabaseResultPromiseLike = PromiseLike<SupabaseResultLike>;

export interface SupabaseFilterLike extends SupabaseResultPromiseLike {
  select(columns?: string): SupabaseFilterLike;
  eq(column: string, value: unknown): SupabaseFilterLike;
  is(column: string, value: null | boolean): SupabaseFilterLike;
  order(column: string, options?: {ascending?: boolean}): SupabaseFilterLike;
  limit(count: number): SupabaseFilterLike;
  single(): SupabaseResultPromiseLike;
  maybeSingle(): SupabaseResultPromiseLike;
}

export interface SupabaseTableLike {
  select(columns?: string): SupabaseFilterLike;
  insert(values: unknown): SupabaseFilterLike;
  update(values: unknown): SupabaseFilterLike;
  delete(): SupabaseFilterLike;
}

export interface SupabaseQueryLike extends SupabaseFilterLike, SupabaseTableLike {
}

export interface SupabaseClientLike {
  from(table: string): SupabaseTableLike;
  rpc(functionName: string, args?: Record<string, unknown>): PromiseLike<SupabaseResultLike>;
  auth: {
    getUser(): PromiseLike<{
      data: {user: {id: string; email?: string; app_metadata?: Record<string, unknown>} | null};
      error: {message: string} | null;
    }>;
  };
}

type ClientInput = SupabaseClientLike | (() => SupabaseClientLike | Promise<SupabaseClientLike>);

export function createSupabaseDataSource(clientInput: ClientInput): DataSource {
  const client = async (): Promise<SupabaseClientLike> => typeof clientInput === 'function' ? clientInput() : clientInput;
  const list = async <T>(table: string, configure?: (query: SupabaseFilterLike) => SupabaseFilterLike): Promise<T[]> => {
    let query = (await client()).from(table).select('*');
    if (configure) query = configure(query);
    return rows<T>(await query);
  };
  const one = async <T>(table: string, configure?: (query: SupabaseFilterLike) => SupabaseFilterLike): Promise<T> => {
    let query = (await client()).from(table).select('*');
    if (configure) query = configure(query);
    return row<T>(await query.single());
  };
  const maybeOne = async <T>(table: string, configure?: (query: SupabaseFilterLike) => SupabaseFilterLike): Promise<T | null> => {
    let query = (await client()).from(table).select('*');
    if (configure) query = configure(query);
    return maybeRow<T>(await query.maybeSingle());
  };
  const insert = async <T>(table: string, value: object): Promise<T> =>
    row<T>(await (await client()).from(table).insert(toDatabaseRow(value)).select('*').single());
  const update = async <T>(table: string, id: Identifier, value: object): Promise<T> =>
    row<T>(await (await client()).from(table).update(toDatabaseRow(value)).eq('id', id).select('*').single());
  const remove = async (table: string, id: Identifier): Promise<void> => {
    throwOnError(await (await client()).from(table).delete().eq('id', id));
  };
  const authUser = async () => {
    const result = await (await client()).auth.getUser();
    if (result.error) throw new Error(result.error.message);
    if (!result.data.user) throw new Error('Authenticated user not found');
    return result.data.user;
  };
  const activeSupportSession = async (): Promise<SupportSession | null> => {
    const user = await authUser();
    if (user.app_metadata?.platform_admin !== true) return null;
    const candidates = await list<SupportSession>('support_sessions', (query) => query.is('ended_at', null).order('started_at', {ascending: false}).limit(5));
    const now = Date.now();
    return candidates.find((session) => Date.parse(session.startedAt) <= now && Date.parse(session.expiresAt) > now) ?? null;
  };
  const currentRestaurant = async (): Promise<Restaurant> => {
    const user = await authUser();
    if (user.app_metadata?.platform_admin === true) {
      const session = await activeSupportSession();
      if (!session) throw new Error('SUPPORT_SESSION_REQUIRED');
      return one<Restaurant>('restaurants', (query) => query.eq('id', session.restaurantId).limit(1));
    }
    return one<Restaurant>('restaurants', (query) => query.limit(1));
  };
  const restaurantId = async (): Promise<string> => (await currentRestaurant()).id;
  const viewerRole = async (): Promise<ViewerRole> => {
    // Server authorization must use a verified user, never getSession().
    // https://supabase.com/docs/guides/auth/server-side/nextjs
    const user = await authUser();
    if (user.app_metadata?.platform_admin === true) return 'platform-admin';
    const restaurant = await currentRestaurant();
    const membership = await maybeOne<{role: 'owner' | 'staff'}>('memberships', (query) =>
      query.eq('organization_id', restaurant.organizationId).eq('user_id', user.id)
    );
    if (!membership) throw new Error('Membership not found for authenticated user');
    return membership.role;
  };

  return {
    getOnboardingState: () => unavailable('onboarding state'),
    saveOnboardingState: () => unavailable('onboarding state'),
    startImportJob: () => unavailable('import jobs'),
    getImportJob: () => unavailable('import jobs'),
    getRestaurant: currentRestaurant,
    getRestaurantById: (id) => one<Restaurant>('restaurants', (query) => query.eq('id', id).limit(1)),
    async updateRestaurantBasics(input) { return update<Restaurant>('restaurants', await restaurantId(), input); },
    async getOrganization() {
      const restaurant = await currentRestaurant();
      return maybeOne('organizations', (query) => query.eq('id', restaurant.organizationId));
    },
    async listMemberships() {
      const restaurant = await currentRestaurant();
      return list('memberships', (query) => query.eq('organization_id', restaurant.organizationId).order('created_at'));
    },
    async getNotificationPreferences() {
      const authResult = await (await client()).auth.getUser();
      if (authResult.error) throw new Error(authResult.error.message);
      if (!authResult.data.user) throw new Error('Authenticated user not found');
      return await maybeOne('notification_preferences', (query) => query.eq('user_id', authResult.data.user!.id).limit(1))
        ?? {messageTaken: true, missedTransfer: true, flaggedCall: true, lowBalance: true, dailyDigest: true};
    },
    async updateNotificationPreferences(input) {
      const authResult = await (await client()).auth.getUser();
      if (authResult.error) throw new Error(authResult.error.message);
      if (!authResult.data.user) throw new Error('Authenticated user not found');
      const current = await maybeOne<{id: string}>('notification_preferences', (query) => query.eq('user_id', authResult.data.user!.id).limit(1));
      if (current) return update('notification_preferences', current.id, input);
      if (!authResult.data.user.email) throw new Error('Authenticated user email is required for notifications');
      const restaurant = await currentRestaurant();
      return insert('notification_preferences', {
        ...input, userId: authResult.data.user.id, organizationId: restaurant.organizationId,
        email: authResult.data.user.email, locale: restaurant.primaryLanguage === 'fr-CA' ? 'fr' : 'en',
      });
    },
    async getLegalSettings() {
      if (await viewerRole() === 'platform-admin') {
        return row<LegalSettings>(await (await client()).rpc('get_support_legal_settings'));
      }
      return row<LegalSettings>(await (await client()).rpc('get_legal_settings'));
    },
    async updateLegalSettings(input) {
      return row<LegalSettings>(await (await client()).rpc('update_legal_settings', prefixKeys(input, 'p_')));
    },
    async listInvoices() {
      const restaurant = await currentRestaurant();
      return list<Invoice>('invoices', (query) => query.eq('organization_id', restaurant.organizationId).order('period', {ascending: false}));
    },
    getViewerRole: viewerRole,
    async listAdminRestaurants() { return rows<AdminRestaurantUsage>(await (await client()).rpc('list_admin_restaurant_usage')); },
    async listAdminPhoneNumbers() { return list<PhoneNumber>('phone_numbers', (query) => query.order('created_at')); },
    async listAuditLogs() { return rows<AuditLog>(await (await client()).rpc('list_admin_audit_logs')); },
    getActiveSupportSession: activeSupportSession,
    async startSupportSession(restaurantId, reason) {
      return row<SupportSession>(await (await client()).rpc('start_support_session', {p_restaurant_id: restaurantId, p_reason: reason}));
    },
    async endSupportSession(sessionId) {
      return row<SupportSession>(await (await client()).rpc('end_support_session', {p_session_id: sessionId}));
    },
    async listFeatureFlags() { return list<FeatureFlag>('feature_flags', (query) => query.order('key').order('restaurant_id')); },
    async setFeatureFlag(key: FeatureFlagKey, selectedRestaurantId: Identifier | null, enabled: boolean) {
      return row<FeatureFlag>(await (await client()).rpc('set_feature_flag', {p_key: key, p_restaurant_id: selectedRestaurantId, p_enabled: enabled}));
    },
    async setPhoneKillSwitch(phoneNumberId, enabled, reason) {
      return row<PhoneNumber>(await (await client()).rpc('set_phone_kill_switch', {p_phone_number_id: phoneNumberId, p_enabled: enabled, p_reason: reason}));
    },
    async listHours() { return list<Hours>('hours', (query) => query.order('weekday')); },
    async createHours(input) { return insert<Hours>('hours', {...input, restaurantId: await restaurantId()}); },
    async listHoursOverrides() { return list<HoursOverride>('hours_overrides', (query) => query.order('date')); },
    async listMenuItems() { return list<MenuItem>('menu_items', (query) => query.order('category').order('name')); },
    async createMenuItem(input: SaveMenuItemInput) { return insert<MenuItem>('menu_items', {...input, restaurantId: await restaurantId()}); },
    async updateMenuItem(id: Identifier, input: SaveMenuItemInput) { return update<MenuItem>('menu_items', id, input); },
    async deleteMenuItem(id: Identifier) { return remove('menu_items', id); },
    async listMenuModifiers() { return list<MenuModifier>('menu_modifiers', (query) => query.order('name')); },
    async createMenuModifier(input: SaveMenuModifierInput) { return insert<MenuModifier>('menu_modifiers', input); },
    async updateMenuModifier(id: Identifier, input: SaveMenuModifierInput) { return update<MenuModifier>('menu_modifiers', id, input); },
    async deleteMenuModifier(id: Identifier) { return remove('menu_modifiers', id); },
    async listFaqs() { return list<Faq>('faqs', (query) => query.order('created_at')); },
    async createFaq(input: CreateFaqInput) { return insert<Faq>('faqs', {...input, restaurantId: await restaurantId()}); },
    async updateFaq(id: Identifier, input: SaveFaqInput) { return update<Faq>('faqs', id, input); },
    async deleteFaq(id: Identifier) { return remove('faqs', id); },
    listPolicies: () => unavailable('agent policies'),
    createPolicy: () => unavailable('agent policies'),
    updatePolicy: () => unavailable('agent policies'),
    deletePolicy: () => unavailable('agent policies'),
    async updateHours(id: Identifier, input: SaveHoursInput) { return update<Hours>('hours', id, input); },
    async createHoursOverride(input: SaveHoursOverrideInput) { return insert<HoursOverride>('hours_overrides', {...input, restaurantId: await restaurantId()}); },
    async updateHoursOverride(id: Identifier, input: SaveHoursOverrideInput) { return update<HoursOverride>('hours_overrides', id, input); },
    async deleteHoursOverride(id: Identifier) { return remove('hours_overrides', id); },
    async getAgent() { return one<Agent>('agents', (query) => query.limit(1)); },
    async updateAgent(id, input) { return update<Agent>('agents', id, input); },
    async updateRestaurantLanguages(enabledLanguages: Language[], primaryLanguage: Language) {
      return update<Restaurant>('restaurants', await restaurantId(), {enabledLanguages, primaryLanguage});
    },
    async updateRestaurantRules(transferPhone: string, transferHours: Record<string, string>) {
      return update<Restaurant>('restaurants', await restaurantId(), {transferPhone, transferHours});
    },
    async updateSlotsConfig(input) { return update<SlotsConfig>('slots_config', (await this.getSlotsConfig()).id, input); },
    async setAgentEnabled(enabled: boolean) { return update<Agent>('agents', (await this.getAgent()).id, {enabled}); },
    async listAgentVersions() { return list<AgentVersion>('agent_versions', (query) => query.order('version_no', {ascending: false})); },
    async getPhoneNumber() { return maybeOne('phone_numbers', (query) => query.limit(1)); },
    async listCalls() { return list<Call>('calls', (query) => query.order('started_at', {ascending: false})); },
    async getActiveCall(): Promise<ActiveCall | null> {
      const active = await maybeOne<Call>('calls', (query) => query.is('ended_at', null).order('started_at', {ascending: false}).limit(1));
      if (!active) return null;
      return {id: active.id, language: active.languages[0] ?? 'en', durationSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(active.startedAt)) / 1000))};
    },
    async listCallTurns(callId) { return list<CallTurn>('call_turns', (query) => query.eq('call_id', callId).order('idx')); },
    async listCallMetrics(callId) { return list<CallMetric>('call_metrics', (query) => query.eq('call_id', callId).order('turn_idx')); },
    async getSlotsConfig() { return one<SlotsConfig>('slots_config', (query) => query.limit(1)); },
    async listBookings() { return list<Booking>('bookings', (query) => query.order('starts_at')); },
    async createBooking(input: SaveBookingInput) {
      const result = await (await client()).rpc('create_booking', {
        p_restaurant_id: await restaurantId(),
        ...prefixKeys(input, 'p_'),
        p_source: await viewerRole(),
      });
      return row<Booking>(result);
    },
    async updateBooking(id, input) { return update<Booking>('bookings', id, input); },
    async listOrders() { return list<Order>('orders', (query) => query.order('pickup_at')); },
    async listOrderItems(orderId) { return list<OrderItem>('order_items', (query) => orderId ? query.eq('order_id', orderId).order('created_at') : query.order('created_at')); },
    async listMessages() { return list<Message>('messages', (query) => query.order('created_at', {ascending: false})); },
    async getUsage() {
      const restaurant = await currentRestaurant();
      return one('usage_ledger', (query) => query.eq('organization_id', restaurant.organizationId).order('period', {ascending: false}).limit(1));
    },
    async updateBookingStatus(id: Identifier, status: BookingStatus) { return update<Booking>('bookings', id, {status}); },
    async updateOrderStatus(id: Identifier, status: OrderStatus) { return update<Order>('orders', id, {status}); },
    async saveAgentDraft(agentId, promptSections, voices = {}, rules = {}) {
      return row<AgentVersion>(await (await client()).rpc('save_agent_draft', {p_agent_id: agentId, p_prompt_sections: promptSections, p_voices: voices, p_rules: rules}));
    },
    async publishAgentVersion(versionId) {
      return row<AgentVersion>(await (await client()).rpc('publish_agent_version', {p_version_id: versionId}));
    },
    async restoreAgentVersion(versionId) {
      return row<AgentVersion>(await (await client()).rpc('restore_agent_version', {p_version_id: versionId}));
    },
    async markMessageHandled(id: Identifier, handled: boolean) { return update<Message>('messages', id, {handled}); }
  };
}

async function unavailable(feature: string): Promise<never> {
  throw new Error(`${feature} is not defined by the Supabase schema`);
}

function throwOnError(result: SupabaseResultLike): void {
  if (result.error) throw new Error(result.error.message);
}

function rows<T>(result: SupabaseResultLike): T[] {
  throwOnError(result);
  if (!Array.isArray(result.data)) throw new Error('Expected a row collection from Supabase');
  return result.data.map((value) => fromDatabaseRow(value) as T);
}

function row<T>(result: SupabaseResultLike): T {
  throwOnError(result);
  if (!result.data || Array.isArray(result.data) || typeof result.data !== 'object') throw new Error('Expected one row from Supabase');
  return fromDatabaseRow(result.data) as T;
}

function maybeRow<T>(result: SupabaseResultLike): T | null {
  throwOnError(result);
  if (result.data === null) return null;
  return row<T>(result);
}

function fromDatabaseRow(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), item]));
}

function toDatabaseRow(value: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['createdAt', 'updatedAt'].includes(key)).map(([key, item]) => [snakeCase(key), item]));
}

function prefixKeys(value: object, prefix: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [`${prefix}${snakeCase(key)}`, item]));
}

function snakeCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
