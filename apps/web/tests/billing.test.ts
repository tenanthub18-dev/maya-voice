import {readFileSync} from 'node:fs';
import {describe, expect, it, vi} from 'vitest';

import {createCheckoutHandler, createPortalHandler} from '@/app/api/billing/_lib';
import {evaluateSpendCap} from '@/lib/billing/spend-cap';
import {billableSeconds} from '@/lib/billing/billable-seconds';
import {pendingUsagePeriods, reportUsageBatch, runIsolatedUsageReports} from '@/lib/billing/usage-reporting';
import {runUsageAlerts} from '@/lib/billing/usage-alerts';
import {createStripeClient} from '@/lib/integrations/stripe';

const roundingCases = JSON.parse(readFileSync(new URL('../../../tests/fixtures/billable-seconds.json', import.meta.url), 'utf8')) as Array<{
  name: string; duration_seconds?: number; cached_billable_seconds?: number; billable_seconds?: number; error?: string;
}>;

describe('billable seconds', () => {
  for (const fixture of roundingCases) {
    it(`matches the shared fixture for ${fixture.name}`, () => {
      if (fixture.error) expect(() => billableSeconds(fixture.duration_seconds)).toThrow(new RegExp(fixture.error, 'u'));
      else expect(billableSeconds(fixture.duration_seconds!, fixture.cached_billable_seconds)).toBe(fixture.billable_seconds);
    });
  }
});

describe('invoice usage reporting', () => {
  type LedgerState = {
    seconds: number;
    reportedSeconds: number;
    stripeReported: boolean;
    reportingIdentifier?: string | null;
    reportingSeconds?: number | null;
  };
  const persistence = (state: LedgerState) => ({
    async stageBatch(candidate: {identifier: string; targetSeconds: number}) {
      if (!state.reportingIdentifier || state.reportingSeconds === null || state.reportingSeconds === undefined) {
        Object.assign(state, {seconds: candidate.targetSeconds, reportingIdentifier: candidate.identifier, reportingSeconds: candidate.targetSeconds, stripeReported: false});
      }
      return {identifier: state.reportingIdentifier!, targetSeconds: state.reportingSeconds!, reportedSeconds: state.reportedSeconds};
    },
    async completeBatch(batch: {identifier: string; targetSeconds: number}) {
      if (state.reportingIdentifier !== batch.identifier) throw new Error('Usage batch changed');
      Object.assign(state, {
        reportedSeconds: batch.targetSeconds,
        reportingIdentifier: null,
        reportingSeconds: null,
        stripeReported: state.seconds === batch.targetSeconds,
      });
    },
  });

  it('reports exactly the sum stored in the ledger and marks it only after success', async () => {
    const calls = roundingCases
      .filter((fixture): fixture is typeof fixture & {duration_seconds: number; billable_seconds: number} => fixture.error === undefined)
      .map((fixture) => ({id: fixture.name, durationSeconds: fixture.duration_seconds, cachedBillableSeconds: fixture.cached_billable_seconds}));
    const fixtureTotal = roundingCases.reduce((total, fixture) => total + (fixture.billable_seconds ?? 0), 0);
    const state = {seconds: 0, reportedSeconds: 0, stripeReported: false};
    const requests: RequestInit[] = [];
    const stripe = createStripeClient({apiKey: 'test', baseUrl: 'https://stripe.test', fetch: async (_url, init) => {
      requests.push(init ?? {});
      const body = new URLSearchParams(String(init?.body));
      return Response.json({object: 'billing.meter_event', event_name: body.get('event_name'), identifier: body.get('identifier'), payload: {stripe_customer_id: body.get('payload[stripe_customer_id]'), value: body.get('payload[value]')}, timestamp: 1_700_000_000});
    }});
    const result = await reportUsageBatch({
      organizationId: owner.organizationId!, period: '2026-10', customerId: 'cus_1', eventName: 'call_minutes', calls,
      ledger: state,
      ...persistence(state),
      createMeterEvent: async (event) => { await stripe.createMeterEvent(event, {idempotencyKey: event.identifier}); },
    });
    expect(result.seconds).toBe(fixtureTotal);
    expect(state).toEqual({seconds: fixtureTotal, reportedSeconds: fixtureTotal, stripeReported: true, reportingIdentifier: null, reportingSeconds: null});
    const meterBody = new URLSearchParams(String(requests[0]?.body));
    expect(meterBody.get('payload[value]')).toBe(String(fixtureTotal));
    expect(meterBody.get('identifier')).toBe(result.identifier);
    expect(new Headers(requests[0]?.headers).get('idempotency-key')).toBe(result.identifier);
    expect(result.identifier).toMatch(/^usage:22222222-2222-4222-8222-222222222222:2026-10:/u);
  });

  it('retries a failed report with the same identifier and never reports an already completed ledger', async () => {
    const state = {seconds: 0, reportedSeconds: 0, stripeReported: false};
    const identifiers: string[] = [];
    let fail = true;
    const input = {
      organizationId: owner.organizationId!, period: '2026-10', customerId: 'cus_1', eventName: 'call_minutes',
      calls: [{id: 'b', durationSeconds: 7}, {id: 'a', durationSeconds: 1}], ledger: state,
      ...persistence(state),
      createMeterEvent: async (event: {identifier: string}) => { identifiers.push(event.identifier); if (fail) throw new Error('Stripe unavailable'); },
    };
    await expect(reportUsageBatch(input)).rejects.toThrow('Stripe unavailable');
    expect(state).toMatchObject({seconds: 18, reportedSeconds: 0, stripeReported: false});
    fail = false;
    await reportUsageBatch(input);
    await reportUsageBatch(input);
    expect(identifiers).toHaveLength(2);
    expect(new Set(identifiers).size).toBe(1);
    expect(state.stripeReported).toBe(true);
    expect(state.reportedSeconds).toBe(18);
  });

  it('reports only newly accumulated seconds when later calls extend the same period', async () => {
    const state = {seconds: 6, reportedSeconds: 6, stripeReported: true};
    const quantities: string[] = [];
    const result = await reportUsageBatch({
      organizationId: owner.organizationId!, period: '2026-10', customerId: 'cus_1', eventName: 'call_seconds',
      calls: [{id: 'first', durationSeconds: 1}, {id: 'later', durationSeconds: 7}], ledger: state,
      ...persistence(state),
      createMeterEvent: async (event) => { quantities.push(event.value); },
    });
    expect(result).toMatchObject({seconds: 18, quantity: 12, reported: true});
    expect(quantities).toEqual(['12']);
    expect(state).toMatchObject({seconds: 18, reportedSeconds: 18, stripeReported: true, reportingIdentifier: null, reportingSeconds: null});
  });

  it('reuses a staged identifier after provider success and preserves a newer call during finalization retry', async () => {
    const state: LedgerState = {seconds: 6, reportedSeconds: 0, stripeReported: false};
    const events: Array<{identifier: string; value: string}> = [];
    const stored = persistence(state);
    let failCompletion = true;
    const run = (calls: Array<{id: string; durationSeconds: number}>) => reportUsageBatch({
      organizationId: owner.organizationId!, period: '2026-10', customerId: 'cus_1', eventName: 'call_seconds', calls, ledger: state,
      stageBatch: stored.stageBatch,
      completeBatch: async (batch) => {
        if (failCompletion) throw new Error('ledger unavailable after provider success');
        await stored.completeBatch(batch);
      },
      createMeterEvent: async ({identifier, value}) => { events.push({identifier, value}); },
    });
    await expect(run([{id: 'first', durationSeconds: 1}])).rejects.toThrow('ledger unavailable');
    state.seconds = 18;
    state.stripeReported = false;
    failCompletion = false;
    await run([{id: 'first', durationSeconds: 1}, {id: 'later', durationSeconds: 7}]);
    expect(events[1]).toEqual(events[0]);
    expect(state).toMatchObject({seconds: 18, reportedSeconds: 6, stripeReported: false, reportingIdentifier: null, reportingSeconds: null});
    await run([{id: 'first', durationSeconds: 1}, {id: 'later', durationSeconds: 7}]);
    expect(events.map((event) => event.value)).toEqual(['6', '6', '12']);
    expect(new Set(events.map((event) => event.identifier)).size).toBe(2);
    expect(state).toMatchObject({seconds: 18, reportedSeconds: 18, stripeReported: true});
  });

  it('keeps failed prior periods pending after the calendar month changes', () => {
    expect(pendingUsagePeriods([
      {period: '2026-10', seconds: 18, reportedSeconds: 6, stripeReported: false},
      {period: '2026-11', seconds: 12, reportedSeconds: 12, stripeReported: true},
    ])).toEqual(['2026-10']);
  });

  it('continues other billing work when one ledger report fails', async () => {
    const attempted: string[] = [];
    const failed = await runIsolatedUsageReports(['broken', 'healthy'], async (name) => {
      attempted.push(name);
      if (name === 'broken') throw new Error('Stripe unavailable');
    });
    expect(failed).toBe(1);
    expect(attempted).toEqual(['broken', 'healthy']);
  });
});

describe('usage and failed-payment alerts', () => {
  it('sends 80 and 100 percent alerts once per period and respects low-balance preferences', async () => {
    const sent = new Set<string>();
    const emails: Array<{type: string; locale: string; eventId: string; detail: string}> = [];
    const common = {
      period: '2026-10', now: new Date('2026-10-27T12:00:00.000Z'), from: 'Receptionist <alerts@example.test>',
      wasSent: async (key: string) => sent.has(key), markSent: async (key: string) => { sent.add(key); },
      send: async (email: {type: string; locale: string; eventId: string; detail: string}) => { emails.push(email); },
    };
    const recipients = [
      {organizationId: 'org-1', restaurantName: 'Chez Nous', email: 'owner@example.com', locale: 'fr' as const, lowBalance: true, usedSeconds: 6_000, bundleMinutes: 100, lastInvoiceStatus: 'paid', paymentFailedAt: null},
      {organizationId: 'org-2', restaurantName: 'Muted', email: 'muted@example.com', locale: 'en' as const, lowBalance: false, usedSeconds: 60_000, bundleMinutes: 100, lastInvoiceStatus: 'paid', paymentFailedAt: null},
    ];
    await runUsageAlerts({...common, recipients});
    await runUsageAlerts({...common, recipients});
    expect(emails.map((email) => email.eventId)).toEqual(['org-1:2026-10:80', 'org-1:2026-10:100']);
    expect(emails.every((email) => email.type === 'low_balance' && email.locale === 'fr')).toBe(true);
  });

  it('sends failed-payment email daily during grace and stops after seven days', async () => {
    const sent = new Set<string>();
    const emails: Array<{type: string; eventId: string}> = [];
    const recipient = {organizationId: 'org-1', restaurantName: 'Cafe', email: 'owner@example.com', locale: 'en' as const, lowBalance: true, usedSeconds: 0, bundleMinutes: 100, lastInvoiceStatus: 'payment_failed', paymentFailedAt: '2026-10-20T16:00:00.000Z'};
    const run = (now: string) => runUsageAlerts({period: '2026-10', now: new Date(now), from: 'alerts@example.test', recipients: [recipient], wasSent: async (key) => sent.has(key), markSent: async (key) => { sent.add(key); }, send: async (email) => { emails.push(email); }});
    await run('2026-10-26T16:00:00.000Z');
    await run('2026-10-26T16:00:00.000Z');
    await run('2026-10-27T16:00:00.000Z');
    expect(emails.map(({type, eventId}) => ({type, eventId}))).toEqual([{type: 'payment_failed', eventId: 'org-1:2026-10:payment_failed:2026-10-26'}]);
  });
});

const owner = {id: 'owner-1', email: 'owner@example.com', role: 'owner' as const, organizationId: '22222222-2222-4222-8222-222222222222'};
const restaurantId = '11111111-1111-4111-8111-111111111111';

describe('spend cap enforcement', () => {
  it('warns at 80 percent and still permits calls below the cap', () => {
    expect(evaluateSpendCap({currentCostMicros: 16_000_000, projectedCallCostMicros: 500_000, spendCapCents: 2_000})).toEqual({
      allowed: true, warning: true, utilization: 0.825,
    });
  });

  it('refuses a call whose projected cost would exceed the cap', () => {
    expect(evaluateSpendCap({currentCostMicros: 19_900_000, projectedCallCostMicros: 200_000, spendCapCents: 2_000})).toEqual({
      allowed: false, warning: true, utilization: 1.005,
    });
  });

  it('refuses a new call once the hard cap is reached exactly', () => {
    expect(evaluateSpendCap({currentCostMicros: 20_000_000, projectedCallCostMicros: 0, spendCapCents: 2_000}).allowed).toBe(false);
  });
});

function request(path: string, body?: unknown) {
  return new Request(`https://app.example${path}`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function dependencies(stripeCustomerId: string | null = null) {
  const state = {savedCustomer: '', checkout: [] as unknown[], portal: [] as unknown[]};
  return {
    state,
    deps: {
      authorize: async () => ({ok: true as const, user: owner}),
      repository: {
        getOrganizationBilling: async () => ({id: owner.organizationId!, name: 'Restaurant Group', stripeCustomerId}),
        getRestaurantIdForOrganization: async () => restaurantId,
        setOrganizationStripeCustomerId: async (_id: string, customerId: string) => { state.savedCustomer = customerId; },
      },
      stripe: {
        createCustomer: vi.fn(async () => ({id: 'cus_123'})),
        createCheckoutSession: vi.fn(async (input: unknown) => {
          state.checkout.push(input);
          return {url: 'https://checkout.stripe.test/session'};
        }),
        createPortalSession: vi.fn(async (input: unknown) => {
          state.portal.push(input);
          return {url: 'https://billing.stripe.test/session'};
        }),
      },
      appUrl: 'https://app.example',
      priceIds: {starter: 'price_starter', growth: 'price_growth', metered: 'price_metered'},
    },
  };
}

describe('billing routes', () => {
  it('creates a customer once and returns a Stripe Checkout redirect URL', async () => {
    const {deps, state} = dependencies();
    const response = await createCheckoutHandler(deps)(request('/api/billing/checkout', {plan: 'growth'}));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({url: 'https://checkout.stripe.test/session'});
    expect(state.savedCustomer).toBe('cus_123');
    expect(state.checkout).toEqual([expect.objectContaining({
      customerId: 'cus_123', basePriceId: 'price_growth', meteredPriceId: 'price_metered', restaurantId,
      successUrl: 'https://app.example/billing/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.example/billing/cancel',
    })]);
  });

  it('returns a portal URL only for an existing Stripe customer', async () => {
    const missing = dependencies();
    expect((await createPortalHandler(missing.deps)(request('/api/billing/portal'))).status).toBe(409);

    const existing = dependencies('cus_existing');
    const response = await createPortalHandler(existing.deps)(request('/api/billing/portal'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({url: 'https://billing.stripe.test/session'});
    expect(existing.state.portal).toEqual([{customerId: 'cus_existing', returnUrl: 'https://app.example/settings'}]);
  });
});
