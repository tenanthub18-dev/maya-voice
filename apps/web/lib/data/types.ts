export type Language = 'en' | 'en-IN' | 'fr-CA' | 'ur' | 'hi' | 'pa' | 'te' | 'ar';
export type Identifier = string;
export type CanadianProvince = 'AB' | 'BC' | 'MB' | 'NB' | 'NL' | 'NS' | 'NT' | 'NU' | 'ON' | 'PE' | 'QC' | 'SK' | 'YT';

export interface BaseEntity {
  id: Identifier;
  createdAt: string;
  updatedAt: string;
}

export interface Restaurant extends BaseEntity {
  organizationId: Identifier;
  name: string;
  address: string;
  province: CanadianProvince;
  timezone: 'America/Toronto';
  primaryLanguage: Language;
  enabledLanguages: Language[];
  transferPhone: string;
  transferHours: Record<string, string>;
  bookingDepositCents: number;
  status: 'draft' | 'live' | 'paused';
}

export interface Organization extends BaseEntity {
  name: string;
  plan: 'starter' | 'growth';
  spendCapCents: number;
  includedMinutes: number;
  lastInvoiceStatus?: 'paid' | 'payment_failed' | null;
  stripeInvoiceEventCreatedAt?: string | null;
}

export interface Membership extends BaseEntity {
  organizationId: Identifier;
  name: string;
  email: string;
  role: 'owner' | 'staff';
}

export interface NotificationPreferences {
  messageTaken: boolean;
  missedTransfer: boolean;
  flaggedCall: boolean;
  lowBalance: boolean;
  dailyDigest: boolean;
}

export interface LegalSettings {
  id?: Identifier;
  restaurantId?: Identifier;
  recordingNotice: string;
  recordingEnabled: boolean;
  transcriptEnabled: boolean;
  legalReviewRequired: boolean;
  privacyPolicyUrl: string;
  recordingRetentionDays?: number;
  transcriptRetentionDays?: number;
}

export interface Invoice extends BaseEntity {
  organizationId: Identifier;
  period: string;
  totalCents: number;
  status: 'open' | 'paid' | 'void';
}

export type ViewerRole = 'owner' | 'staff' | 'platform-admin';

export interface AdminRestaurantUsage {
  restaurantId: Identifier;
  name: string;
  status: Restaurant['status'];
  calls: number;
  minutes: number;
  costMicros: number;
}

export type FeatureFlagKey = 'diner_payments';

export interface FeatureFlag {
  id: Identifier;
  key: FeatureFlagKey;
  restaurantId: Identifier | null;
  enabled: boolean;
  updatedBy: Identifier | null;
  updatedAt: string;
}

export interface SupportSession {
  id: Identifier;
  adminUserId: Identifier;
  restaurantId: Identifier;
  reason: string;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
}

export interface AuditLog extends BaseEntity {
  actorId: Identifier;
  action: string;
  target: string;
  reason: string;
}

export interface Hours extends BaseEntity {
  restaurantId: Identifier;
  weekday: number;
  openTime: string;
  closeTime: string;
}

export interface HoursOverride extends BaseEntity {
  restaurantId: Identifier;
  date: string;
  openTime: string | null;
  closeTime: string | null;
}

export interface MenuItem extends BaseEntity {
  restaurantId: Identifier;
  name: string;
  description: string;
  priceCents: number;
  category: string;
  dietaryTags: string[];
  available: boolean;
}

export interface MenuModifier extends BaseEntity {
  menuItemId: Identifier;
  name: string;
  priceDeltaCents: number;
  required: boolean;
  maxSelect: number;
}

export interface Policy extends BaseEntity {
  agentId: Identifier;
  title: string;
  content: string;
}

export interface Faq extends BaseEntity {
  restaurantId: Identifier;
  question: string;
  answer: string;
  language: Language;
  source: 'import' | 'owner' | 'teach';
}

export interface Agent extends BaseEntity {
  restaurantId: Identifier;
  personaName: string;
  fillerLevel: 'none' | 'low' | 'natural';
  currentPublishedVersionId: Identifier | null;
  enabled: boolean;
}

export interface ActiveCall {
  id: Identifier;
  language: Language;
  durationSeconds: number;
}

export type CreateFaqInput = Pick<Faq, 'question' | 'answer' | 'language' | 'source'>;
export type SaveMenuItemInput = Pick<MenuItem, 'name' | 'description' | 'priceCents' | 'category' | 'dietaryTags' | 'available'>;
export type SaveMenuModifierInput = Pick<MenuModifier, 'menuItemId' | 'name' | 'priceDeltaCents' | 'required' | 'maxSelect'>;
export type SaveFaqInput = CreateFaqInput;
export type SavePolicyInput = Pick<Policy, 'title' | 'content'>;
export type SaveHoursInput = Pick<Hours, 'openTime' | 'closeTime'>;
export type SaveHoursOverrideInput = Pick<HoursOverride, 'date' | 'openTime' | 'closeTime'>;
export type SaveAgentInput = Pick<Agent, 'personaName' | 'fillerLevel'>;

export interface AgentVersion extends BaseEntity {
  agentId: Identifier;
  versionNo: number;
  status: 'draft' | 'published' | 'archived';
  promptSections: Record<string, string>;
  voices: Partial<Record<Language, string>>;
  rules: Record<string, boolean | number | string>;
  publishedAt: string | null;
  publishedBy: Identifier | null;
}

export interface PhoneNumber extends BaseEntity {
  restaurantId: Identifier;
  e164: string;
  telnyxNumberId: string;
  status: 'pending' | 'active' | 'released';
  forwardingVerifiedAt: string | null;
  killSwitch: boolean;
}

// Nested usage JSON retains its database snake_case keys (only row keys are converted).
export interface CallUsageTotals {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cache_read_input_tokens: number | null;
  total_tokens: number | null;
  audio_seconds: number | null;
  characters: number | null;
  generated_audio_seconds: number | null;
  input_audio_tokens?: number | null;
  output_audio_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  reasoning_tokens?: number | null;
  cache_read_input_audio_tokens?: number | null;
}

export type CallCostStatus = 'partial' | 'estimated' | 'unavailable';

export interface CallUsageService {
  kind: 'stt' | 'tts' | 'llm';
  processor: string;
  model: string | null;
  units: Partial<CallUsageTotals>;
  reported_events: number;
  cost_micros: number | null;
  cost_status: CallCostStatus;
  cost_basis: string;
}

export interface CallUsage {
  schema_version: 1;
  currency: 'USD';
  rate_as_of: string | null;
  cost_status: CallCostStatus;
  usage_complete: boolean;
  totals: CallUsageTotals;
  services: CallUsageService[];
}

export interface Call extends BaseEntity {
  restaurantId: Identifier;
  agentVersionId: Identifier;
  source?: 'phone' | 'browser';
  telnyxCallId: string | null;
  fromE164Hash: string | null;
  fromLast4: string | null;
  startedAt: string;
  endedAt: string | null;
  billableSeconds: number;
  outcome: 'booking' | 'order' | 'message' | 'answered' | 'transferred';
  languages: Language[];
  transferred: boolean;
  recordingPath: string | null;
  summary: string;
  qaFlags: string[];
  costMicros: Record<string, number>;
  usage?: CallUsage | null;
}

export interface CallTurn extends BaseEntity {
  callId: Identifier;
  idx: number;
  speaker: 'caller' | 'agent';
  language: Language;
  text: string;
  startedMs: number;
  endedMs: number;
  interrupted: boolean;
}

export interface CallMetric extends BaseEntity {
  callId: Identifier;
  turnIdx: number;
  eotMs: number;
  sttMs: number;
  llmTtftMs: number;
  ttsTtfbMs: number;
  totalMs: number;
}

export type BookingStatus = 'confirmed' | 'seated' | 'cancelled' | 'no-show';
export interface SlotsConfig extends BaseEntity {
  restaurantId: Identifier;
  slotMinutes: number;
  coversPerSlot: number;
  seatingMinutes: number;
  maxParty: number;
  leadTimeMinutes: number;
  bookingWindowDays: number;
}

export interface Booking extends BaseEntity {
  restaurantId: Identifier;
  callId: Identifier | null;
  name: string;
  phoneE164: string;
  partySize: number;
  startsAt: string;
  status: BookingStatus;
  paidStatus: 'unpaid' | 'paid' | 'refunded';
  notes: string;
  source: 'call' | 'owner';
}

export type SaveBookingInput = Pick<Booking, 'name' | 'phoneE164' | 'partySize' | 'startsAt' | 'notes'>;

export interface Order extends BaseEntity {
  restaurantId: Identifier;
  callId: Identifier | null;
  name: string;
  phone: string;
  pickupAt: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidStatus: 'unpaid' | 'paid' | 'refunded';
  status: 'new' | 'in-progress' | 'ready';
}

export type OrderStatus = Order['status'];

export interface OrderItem extends BaseEntity {
  orderId: Identifier;
  item: string;
  modifiers: string[];
  modifierPriceCents: number[];
  quantity: number;
  priceCents: number;
}

export interface Message extends BaseEntity {
  restaurantId: Identifier;
  callId: Identifier | null;
  callerName: string;
  phone: string;
  text: string;
  handled: boolean;
}

export interface Usage extends BaseEntity {
  organizationId: Identifier;
  period: string;
  seconds: number;
  stripeReported: boolean;
  costMicros: number;
}

export type OnboardingStep = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface OnboardingState {
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  basics: {
    name: string;
    address: string;
    websiteUrl: string;
    cuisine: string;
  };
  importJobId: Identifier | null;
  voice: {
    personaName: string;
    selectedVoice: string;
    primaryLanguage: Language;
    enabledLanguages: Language[];
  };
  rules: {
    maxParty: number;
    bookingWindowDays: number;
    takeoutEnabled: boolean;
    depositRule: string;
    transferPhone: string;
  };
  testCallAcknowledged: boolean;
  number: {
    mode: 'new' | 'forward' | null;
    areaCode: string;
    plan: 'starter' | 'growth' | null;
  };
}

export type SaveOnboardingStateInput = Partial<Omit<OnboardingState, 'currentStep' | 'completedSteps'>> & {
  completedStep?: OnboardingStep;
};

export interface ImportJob {
  id: Identifier;
  url: string;
  status: 'queued' | 'fetching' | 'extracting' | 'complete';
  progress: 0 | 30 | 70 | 100;
}

export interface DataSource {
  getOnboardingState(): Promise<OnboardingState>;
  saveOnboardingState(input: SaveOnboardingStateInput): Promise<OnboardingState>;
  startImportJob(url: string): Promise<ImportJob>;
  getImportJob(id: Identifier): Promise<ImportJob>;
  getRestaurant(): Promise<Restaurant>;
  getRestaurantById(id: Identifier): Promise<Restaurant>;
  updateRestaurantBasics(input: Pick<Restaurant, 'name' | 'address'>): Promise<Restaurant>;
  getOrganization(): Promise<Organization | null>;
  listMemberships(): Promise<Membership[]>;
  getNotificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreferences(input: NotificationPreferences): Promise<NotificationPreferences>;
  getLegalSettings(): Promise<LegalSettings>;
  updateLegalSettings(input: Pick<LegalSettings, 'recordingNotice' | 'recordingEnabled' | 'transcriptEnabled' | 'recordingRetentionDays' | 'transcriptRetentionDays'>): Promise<LegalSettings>;
  listInvoices(): Promise<Invoice[]>;
  getViewerRole(): Promise<ViewerRole>;
  listAdminRestaurants(): Promise<AdminRestaurantUsage[]>;
  listAdminPhoneNumbers(): Promise<PhoneNumber[]>;
  listAuditLogs(): Promise<AuditLog[]>;
  getActiveSupportSession(): Promise<SupportSession | null>;
  startSupportSession(restaurantId: Identifier, reason: string): Promise<SupportSession>;
  endSupportSession(sessionId: Identifier): Promise<SupportSession>;
  listFeatureFlags(): Promise<FeatureFlag[]>;
  setFeatureFlag(key: FeatureFlagKey, restaurantId: Identifier | null, enabled: boolean): Promise<FeatureFlag>;
  setPhoneKillSwitch(phoneNumberId: Identifier, enabled: boolean, reason: string): Promise<PhoneNumber>;
  listHours(): Promise<Hours[]>;
  createHours(input: Pick<Hours, 'weekday' | 'openTime' | 'closeTime'>): Promise<Hours>;
  listHoursOverrides(): Promise<HoursOverride[]>;
  listMenuItems(): Promise<MenuItem[]>;
  createMenuItem(input: SaveMenuItemInput): Promise<MenuItem>;
  updateMenuItem(id: Identifier, input: SaveMenuItemInput): Promise<MenuItem>;
  deleteMenuItem(id: Identifier): Promise<void>;
  listMenuModifiers(): Promise<MenuModifier[]>;
  createMenuModifier(input: SaveMenuModifierInput): Promise<MenuModifier>;
  updateMenuModifier(id: Identifier, input: SaveMenuModifierInput): Promise<MenuModifier>;
  deleteMenuModifier(id: Identifier): Promise<void>;
  listFaqs(): Promise<Faq[]>;
  createFaq(input: CreateFaqInput): Promise<Faq>;
  updateFaq(id: Identifier, input: SaveFaqInput): Promise<Faq>;
  deleteFaq(id: Identifier): Promise<void>;
  listPolicies(): Promise<Policy[]>;
  createPolicy(input: SavePolicyInput): Promise<Policy>;
  updatePolicy(id: Identifier, input: SavePolicyInput): Promise<Policy>;
  deletePolicy(id: Identifier): Promise<void>;
  updateHours(id: Identifier, input: SaveHoursInput): Promise<Hours>;
  createHoursOverride(input: SaveHoursOverrideInput): Promise<HoursOverride>;
  updateHoursOverride(id: Identifier, input: SaveHoursOverrideInput): Promise<HoursOverride>;
  deleteHoursOverride(id: Identifier): Promise<void>;
  getAgent(): Promise<Agent>;
  updateAgent(id: Identifier, input: SaveAgentInput): Promise<Agent>;
  updateRestaurantLanguages(enabledLanguages: Language[], primaryLanguage: Language): Promise<Restaurant>;
  updateRestaurantRules(transferPhone: string, transferHours: Record<string, string>): Promise<Restaurant>;
  updateSlotsConfig(input: Pick<SlotsConfig, 'slotMinutes' | 'coversPerSlot' | 'seatingMinutes' | 'maxParty' | 'leadTimeMinutes' | 'bookingWindowDays'>): Promise<SlotsConfig>;
  setAgentEnabled(enabled: boolean): Promise<Agent>;
  listAgentVersions(): Promise<AgentVersion[]>;
  getPhoneNumber(): Promise<PhoneNumber | null>;
  listCalls(): Promise<Call[]>;
  getActiveCall(): Promise<ActiveCall | null>;
  listCallTurns(callId: Identifier): Promise<CallTurn[]>;
  listCallMetrics(callId: Identifier): Promise<CallMetric[]>;
  getSlotsConfig(): Promise<SlotsConfig>;
  listBookings(): Promise<Booking[]>;
  createBooking(input: SaveBookingInput): Promise<Booking>;
  updateBooking(id: Identifier, input: SaveBookingInput): Promise<Booking>;
  listOrders(): Promise<Order[]>;
  listOrderItems(orderId?: Identifier): Promise<OrderItem[]>;
  listMessages(): Promise<Message[]>;
  getUsage(): Promise<Usage>;
  updateBookingStatus(id: Identifier, status: BookingStatus): Promise<Booking>;
  updateOrderStatus(id: Identifier, status: OrderStatus): Promise<Order>;
  saveAgentDraft(agentId: Identifier, promptSections: Record<string, string>, voices?: AgentVersion['voices'], rules?: AgentVersion['rules']): Promise<AgentVersion>;
  publishAgentVersion(versionId: Identifier): Promise<AgentVersion>;
  restoreAgentVersion(versionId: Identifier): Promise<AgentVersion>;
  markMessageHandled(id: Identifier, handled: boolean): Promise<Message>;
}
