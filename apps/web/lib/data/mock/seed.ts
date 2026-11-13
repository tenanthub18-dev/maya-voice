import type {ActiveCall, AdminRestaurantUsage, Agent, AgentVersion, AuditLog, Booking, Call, CallMetric, CallTurn, Faq, Hours, HoursOverride, Invoice, LegalSettings, Membership, MenuItem, MenuModifier, Message, NotificationPreferences, OnboardingState, Order, OrderItem, Organization, PhoneNumber, Policy, Restaurant, SlotsConfig, Usage, ViewerRole} from '../types';
import {calculateOrderTotals} from '../../orders/totals';
import {BRAND} from '../../brand';

const stamp = '2026-10-27T12:00:00.000Z';
const base = (id: string) => ({id, createdAt: stamp, updatedAt: stamp});
const restaurantId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const agentId = 'agent-001';
const versionId = 'agent-version-003';

export interface MockSeed {
  onboardingState: OnboardingState;
  organization: Organization;
  restaurant: Restaurant;
  memberships: Membership[];
  notificationPreferences: NotificationPreferences;
  legalSettings: LegalSettings;
  invoices: Invoice[];
  viewerRole: ViewerRole;
  adminRestaurants: AdminRestaurantUsage[];
  auditLogs: AuditLog[];
  hours: Hours[];
  hoursOverrides: HoursOverride[];
  menuItems: MenuItem[];
  menuModifiers: MenuModifier[];
  faqs: Faq[];
  policies: Policy[];
  agent: Agent;
  activeCall: ActiveCall | null;
  agentVersions: AgentVersion[];
  phoneNumber: PhoneNumber;
  calls: Call[];
  callTurns: CallTurn[];
  callMetrics: CallMetric[];
  slotsConfig: SlotsConfig;
  bookings: Booking[];
  orders: Order[];
  orderItems: OrderItem[];
  messages: Message[];
  usage: Usage;
}

const languageCycle = ['en', 'fr-CA', 'ur', 'hi', 'pa', 'en-IN', 'te', 'ar'] as const;
const transcriptText = {
  en: ['I would like a table for four.', 'Your table is confirmed for seven thirty.'],
  'en-IN': ['I would like to book a table for four, please.', 'Your table is confirmed for seven thirty, sir.'],
  'fr-CA': ['Je voudrais réserver une table pour quatre.', 'Votre table est confirmée pour dix-neuf heures trente.'],
  ur: ['مجھے چار لوگوں کے لیے میز چاہیے۔', 'آپ کی میز ساڑھے سات بجے کے لیے بک ہو گئی ہے۔'],
  hi: ['मुझे चार लोगों के लिए मेज़ चाहिए।', 'आपकी मेज़ साढ़े सात बजे के लिए बुक हो गई है।'],
  pa: ['ਮੈਨੂੰ ਚਾਰ ਲੋਕਾਂ ਲਈ ਮੇਜ਼ ਚਾਹੀਦਾ ਹੈ।', 'ਤੁਹਾਡੀ ਮੇਜ਼ ਸਾਢੇ ਸੱਤ ਵਜੇ ਲਈ ਬੁੱਕ ਹੋ ਗਈ ਹੈ।'],
  te: ['నాలుగు మందికి టేబుల్ బుక్ చేయాలి.', 'మీ టేబుల్ రాత్రి ఏడున్నరకు నిర్ధారించబడింది.'],
  ar: ['أريد حجز طاولة لأربعة أشخاص.', 'تم تأكيد طاولتك الساعة السابعة والنصف مساءً.']
} as const;

export function buildSeed(): MockSeed {
  const organization: Organization = {...base(organizationId), name: 'Harbour Table Group', plan: 'growth', spendCapCents: 20_000, includedMinutes: 500, lastInvoiceStatus: 'paid', stripeInvoiceEventCreatedAt: null};
  const restaurant: Restaurant = {
    ...base(restaurantId), organizationId, name: 'Harbour Table',
    address: '88 Queens Quay W, Toronto, ON', province: 'ON', timezone: 'America/Toronto',
    primaryLanguage: 'en', enabledLanguages: [...languageCycle], transferPhone: '+14165550199',
    transferHours: {daily: '11:00-22:00'}, bookingDepositCents: 2_000, status: 'live'
  };
  const onboardingState: OnboardingState = {
    currentStep: 1,
    completedSteps: [],
    basics: {name: restaurant.name, address: restaurant.address, websiteUrl: '', cuisine: ''},
    importJobId: null,
    voice: {
      personaName: BRAND.defaultPersonaName,
      selectedVoice: 'warm',
      primaryLanguage: restaurant.primaryLanguage,
      enabledLanguages: [...restaurant.enabledLanguages]
    },
    rules: {
      maxParty: 8,
      bookingWindowDays: 90,
      takeoutEnabled: true,
      depositRule: 'none',
      transferPhone: restaurant.transferPhone
    },
    testCallAcknowledged: false,
    number: {mode: null, areaCode: '416', plan: null}
  };
  const memberships: Membership[] = [
    {...base('membership-001'), organizationId: organization.id, name: 'Avery Singh', email: 'avery@example.com', role: 'owner'},
    {...base('membership-002'), organizationId: organization.id, name: 'Camille Roy', email: 'camille@example.com', role: 'staff'}
  ];
  const notificationPreferences: NotificationPreferences = {messageTaken: true, missedTransfer: true, flaggedCall: true, lowBalance: true, dailyDigest: false};
  const legalSettings: LegalSettings = {
    recordingNotice: 'This call may be recorded for quality and training purposes. By continuing, you consent to the recording.',
    recordingEnabled: true,
    transcriptEnabled: true,
    recordingRetentionDays: 90,
    transcriptRetentionDays: 365,
    legalReviewRequired: true,
    privacyPolicyUrl: 'https://example.com/privacy'
  };
  const invoices: Invoice[] = [];
  const viewerRole: ViewerRole = 'platform-admin';
  const auditLogs: AuditLog[] = [];
  const hours = Array.from({length: 7}, (_, weekday): Hours => ({...base(`hours-${weekday}`), restaurantId, weekday, openTime: weekday === 0 ? '12:00' : '11:00', closeTime: '22:00'}));
  const hoursOverrides: HoursOverride[] = [{...base('override-001'), restaurantId, date: '2026-12-25', openTime: null, closeTime: null}];
  const menuItems: MenuItem[] = [
    {...base('menu-001'), restaurantId, name: 'Butter chicken', description: 'Tomato, cream and spice', priceCents: 2195, category: 'Mains', dietaryTags: [], available: true},
    {...base('menu-002'), restaurantId, name: 'Chana masala', description: 'Chickpeas and warming spice', priceCents: 1695, category: 'Mains', dietaryTags: ['vegan'], available: true}
  ];
  const menuModifiers: MenuModifier[] = [{...base('modifier-001'), menuItemId: 'menu-001', name: 'Extra naan', priceDeltaCents: 350, required: false, maxSelect: 2}];
  const faqs: Faq[] = [{...base('faq-001'), restaurantId, question: 'Is parking available?', answer: 'Paid parking is available next door.', language: 'en', source: 'owner'}];
  const policies: Policy[] = [{...base('policy-001'), agentId, title: 'Allergies', content: 'Never guarantee an allergen-free meal; offer to transfer the call to staff.'}];
  const agentVersions: AgentVersion[] = [
    {...base('agent-version-002'), agentId, versionNo: 2, status: 'archived', promptSections: {greeting: 'Hello'}, voices: {}, rules: {takeout: true}, publishedAt: '2026-10-01T12:00:00.000Z', publishedBy: 'owner-001'},
    {...base(versionId), agentId, versionNo: 3, status: 'published', promptSections: {greeting: 'Good afternoon'}, voices: {}, rules: {takeout: true}, publishedAt: '2026-10-20T12:00:00.000Z', publishedBy: 'owner-001'},
    {...base('agent-version-004'), agentId, versionNo: 4, status: 'draft', promptSections: {persona: `${BRAND.defaultPersonaName} is a calm, concise restaurant host.`, greeting: 'Good afternoon', rules: 'Confirm important details once.'}, voices: {}, rules: {takeout: true}, publishedAt: null, publishedBy: null}
  ];
  const agent: Agent = {...base(agentId), restaurantId, personaName: BRAND.defaultPersonaName, fillerLevel: 'low', currentPublishedVersionId: versionId, enabled: true};
  const phoneNumber: PhoneNumber = {...base('33333333-3333-4333-8333-333333333333'), restaurantId, e164: '+14165550123', telnyxNumberId: 'telnyx-number-demo', status: 'active', forwardingVerifiedAt: null, killSwitch: false};
  const calls = Array.from({length: 40}, (_, index): Call => {
    const day = 27 - (index % 14);
    const startedAt = `2026-10-${String(day).padStart(2, '0')}T${String(12 + (index % 8)).padStart(2, '0')}:00:00.000Z`;
    const seconds = 60 + (index % 7) * 18;
    const outcome = (['booking', 'order', 'message', 'answered', 'transferred'] as const)[index % 5];
    const language = languageCycle[index % languageCycle.length];
    const adjustedOutcome = index === 0 ? 'transferred' : outcome;
    const adjustedLanguage = index === 0 ? 'en' : language;
    return {...base(`call-${String(index + 1).padStart(3, '0')}`), restaurantId, agentVersionId: versionId, telnyxCallId: `demo-call-${index + 1}`, fromE164Hash: `hash-${index + 1}`, fromLast4: String(4100 + index), startedAt, endedAt: new Date(Date.parse(startedAt) + seconds * 1000).toISOString(), billableSeconds: seconds, outcome: adjustedOutcome, languages: [adjustedLanguage], transferred: adjustedOutcome === 'transferred', recordingPath: null, summary: `Demo ${adjustedOutcome} call`, qaFlags: index % 13 === 0 ? ['review'] : [], costMicros: {stt: 5200 + index, llm: 2600 + index, tts: 7100 + index}};
  });
  const callTurns = calls.flatMap((call, index): CallTurn[] => {
    const language = languageCycle[index % languageCycle.length];
    return transcriptText[language].map((text, turnIndex) => ({...base(`${call.id}-turn-${turnIndex}`), callId: call.id, idx: turnIndex, speaker: turnIndex === 0 ? 'caller' : 'agent', language, text, startedMs: turnIndex * 1600, endedMs: turnIndex * 1600 + 1300, interrupted: false}));
  });
  const totalLatencies = [640, 660, 680, 700, 720, 1120];
  const callMetrics = calls.flatMap((call): CallMetric[] => totalLatencies.map((totalMs, turnIdx) => ({...base(`${call.id}-metric-${turnIdx}`), callId: call.id, turnIdx, eotMs: 105 + turnIdx * 4, sttMs: 145 + turnIdx * 5, llmTtftMs: 195 + turnIdx * 6, ttsTtfbMs: 155 + turnIdx * 5, totalMs})));
  const slotsConfig: SlotsConfig = {...base('slots-config-001'), restaurantId, slotMinutes: 15, coversPerSlot: 16, seatingMinutes: 90, maxParty: 8, leadTimeMinutes: 60, bookingWindowDays: 90};
  const bookings: Booking[] = calls.filter((call) => call.outcome === 'booking').map((call, index) => ({...base(`booking-${index + 1}`), restaurantId, callId: call.id, name: `Guest ${index + 1}`, phoneE164: `+14165550${String(200 + index)}`, partySize: 2 + (index % 5), startsAt: `2026-10-${index % 2 === 0 ? '27' : '28'}T${17 + (index % 4)}:30:00.000Z`, status: 'confirmed', paidStatus: index % 2 ? 'unpaid' : 'paid', notes: '', source: 'call'}));
  const orders: Order[] = calls.filter((call) => call.outcome === 'order').map((call, index) => {
    const totals = calculateOrderTotals([{quantity: 1, unitPriceCents: 2195, modifierPriceCents: index % 2 ? [350] : []}], 1300);
    return {...base(`order-${index + 1}`), restaurantId, callId: call.id, name: `Pickup ${index + 1}`, phone: `+14165550${String(300 + index)}`, pickupAt: `2026-10-27T${17 + (index % 4)}:30:00.000Z`, ...totals, paidStatus: index % 2 ? 'paid' : 'unpaid', status: (['new', 'in-progress', 'ready'] as const)[index % 3]};
  });
  const orderItems: OrderItem[] = orders.map((order, index) => ({...base(`order-item-${index + 1}`), orderId: order.id, item: 'Butter chicken', modifiers: index % 2 ? ['Extra naan'] : [], modifierPriceCents: index % 2 ? [350] : [], quantity: 1, priceCents: 2195}));
  const messages: Message[] = calls.filter((call) => call.outcome === 'message').map((call, index) => ({...base(`message-${index + 1}`), restaurantId, callId: call.id, callerName: `Caller ${index + 1}`, phone: `+14165550${String(400 + index)}`, text: `Please call me back about event dining ${index + 1}.`, handled: index % 2 === 0}));
  const usage: Usage = {...base('usage-2026-10'), organizationId: restaurant.organizationId, period: '2026-10', seconds: calls.reduce((sum, call) => sum + call.billableSeconds, 0), stripeReported: false, costMicros: calls.reduce((sum, call) => sum + Object.values(call.costMicros).reduce((part, value) => part + value, 0), 0)};
  const adminRestaurants: AdminRestaurantUsage[] = [{restaurantId, name: restaurant.name, status: restaurant.status, calls: calls.length, minutes: usage.seconds / 60, costMicros: usage.costMicros}];
  const activeCall: ActiveCall = {id: 'call-active-001', language: 'fr-CA', durationSeconds: 94};
  return {onboardingState, organization, restaurant, memberships, notificationPreferences, legalSettings, invoices, viewerRole, adminRestaurants, auditLogs, hours, hoursOverrides, menuItems, menuModifiers, faqs, policies, agent, activeCall, agentVersions, phoneNumber, calls, callTurns, callMetrics, slotsConfig, bookings, orders, orderItems, messages, usage};
}
