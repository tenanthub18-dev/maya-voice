import {createClient} from '@supabase/supabase-js';

import {createDigestCronHandler} from '@/app/api/cron/digest/_lib';
import {runUsageAlerts, type BillingAlertRecipient} from '@/lib/billing/usage-alerts';
import {pendingUsagePeriods, reportUsageBatch, runIsolatedUsageReports} from '@/lib/billing/usage-reporting';
import {createResendClient} from '@/lib/integrations/resend';
import {getProviderBaseUrl} from '@/lib/integrations/mode';
import {createStripeClient} from '@/lib/integrations/stripe';
import {sendOwnerNotification} from '@/lib/notifications/sender';

type EnvName = 'CRON_SECRET' | 'RESEND_API_KEY' | 'RESEND_FROM_EMAIL' | 'STRIPE_SECRET_KEY' | 'STRIPE_METER_EVENT_NAME' | 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY' | 'STARTER_INCLUDED_MINUTES' | 'GROWTH_INCLUDED_MINUTES';

function integrationValue(name: EnvName, mockValue?: string): string {
  const value = process.env[name];
  if (value) return value;
  if ((process.env.INTEGRATIONS_MODE ?? 'mock') === 'mock' && mockValue !== undefined) return mockValue;
  throw new Error(`${name} is required`);
}

function bundleMinutes(plan: string): number {
  const name = plan === 'starter' ? 'STARTER_INCLUDED_MINUTES' : plan === 'growth' ? 'GROWTH_INCLUDED_MINUTES' : undefined;
  if (!name) throw new Error(`Unsupported billing plan: ${plan}`);
  const value = Number(integrationValue(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function createUsageAlertsCronHandler(deps: {secret: string; run: () => Promise<{sent: number; failed: number}>}) {
  return createDigestCronHandler(deps);
}

function parseAlertKey(key: string): {organizationId: string; period: string; threshold: string} {
  const [organizationId, period, ...thresholdParts] = key.split(':');
  if (!organizationId || !/^\d{4}-\d{2}$/u.test(period ?? '') || thresholdParts.length === 0) throw new Error('Invalid billing alert key');
  return {organizationId, period: period!, threshold: thresholdParts.join(':')};
}

async function liveRecipients(period: string): Promise<{
  recipients: BillingAlertRecipient[];
  billingFailures: number;
  wasSent: (key: string) => Promise<boolean>;
  markSent: (key: string) => Promise<void>;
}> {
  // Service-role use is confined to this authenticated cron job.
  // https://supabase.com/docs/guides/api/api-keys
  const client = createClient(integrationValue('SUPABASE_URL'), integrationValue('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
  });
  const [organizations, usage, preferences, memberships, restaurants] = await Promise.all([
    client.from('organizations').select('id,plan,stripe_customer_id,last_invoice_status,stripe_invoice_event_created_at'),
    client.from('usage_ledger').select('id,organization_id,period,seconds,reported_seconds,stripe_reported,reporting_identifier,reporting_seconds'),
    client.from('notification_preferences').select('user_id,organization_id,email,locale,low_balance'),
    client.from('memberships').select('user_id,organization_id').eq('role', 'owner'),
    client.from('restaurants').select('id,organization_id,name').order('created_at'),
  ]);
  for (const result of [organizations, usage, preferences, memberships, restaurants]) {
    if (result.error) throw new Error(result.error.message);
  }
  const restaurantOrganization = new Map((restaurants.data ?? []).map((row) => [String(row.id), String(row.organization_id)]));
  const organizationById = new Map((organizations.data ?? []).map((row) => [String(row.id), row]));
  const meteredSecondsByOrganization = new Map(
    (usage.data ?? []).filter((row) => row.period === period).map((row) => [String(row.organization_id), Number(row.seconds)]),
  );
  const ledgerPeriods = (usage.data ?? []).map((row) => ({
    period: String(row.period),
    seconds: Number(row.seconds),
    reportedSeconds: Number(row.reported_seconds),
    stripeReported: Boolean(row.stripe_reported),
  }));
  const pendingPeriods = new Set(pendingUsagePeriods(ledgerPeriods));
  const pendingLedgers = (usage.data ?? []).filter((row) => pendingPeriods.has(String(row.period))
    && (!row.stripe_reported || Number(row.reported_seconds) < Number(row.seconds)));
  const stripe = pendingLedgers.length === 0 ? null : createStripeClient({
      apiKey: integrationValue('STRIPE_SECRET_KEY'),
      baseUrl: getProviderBaseUrl('stripe'),
    });
  const billingFailures = await runIsolatedUsageReports(pendingLedgers, async (ledger) => {
    const organizationId = String(ledger.organization_id);
    const organization = organizationById.get(organizationId);
    if (!organization) throw new Error('Usage ledger organization was not found');
    const customerId = organization.stripe_customer_id ? String(organization.stripe_customer_id) : '';
    if (!customerId) return;
    const reportPeriod = String(ledger.period);
    const [year, month] = reportPeriod.split('-').map(Number);
    const nextPeriod = new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 7);
    const calls = await client.from('calls')
      .select('id,restaurant_id,started_at,ended_at,billable_seconds')
      .gte('started_at', `${reportPeriod}-01T00:00:00.000Z`)
      .lt('started_at', `${nextPeriod}-01T00:00:00.000Z`);
    if (calls.error) throw new Error(calls.error.message);
    const batch = (calls.data ?? []).flatMap((call) => {
      if (!call.ended_at || restaurantOrganization.get(String(call.restaurant_id)) !== organizationId) return [];
      const durationSeconds = (Date.parse(String(call.ended_at)) - Date.parse(String(call.started_at))) / 1_000;
      if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error('Invalid completed call in billing period');
      return [{id: String(call.id), durationSeconds, cachedBillableSeconds: Number(call.billable_seconds)}];
    });
    if (batch.length === 0) throw new Error('Pending usage ledger has no completed calls');
    const ledgerState = {
      seconds: Number(ledger.seconds),
      reportedSeconds: Number(ledger.reported_seconds),
      stripeReported: Boolean(ledger.stripe_reported),
      reportingIdentifier: ledger.reporting_identifier === null ? null : String(ledger.reporting_identifier),
      reportingSeconds: ledger.reporting_seconds === null ? null : Number(ledger.reporting_seconds),
    };
    const report = await reportUsageBatch({
      organizationId,
      period: reportPeriod,
      customerId,
      eventName: integrationValue('STRIPE_METER_EVENT_NAME'),
      calls: batch,
      ledger: ledgerState,
      async stageBatch(candidate) {
        // The database RPC atomically claims or returns the existing batch.
        // https://supabase.com/docs/reference/javascript/rpc
        const result = await client.rpc('claim_usage_report', {
          p_organization_id: organizationId,
          p_period: reportPeriod,
          p_target_seconds: candidate.targetSeconds,
          p_identifier: candidate.identifier,
        });
        if (result.error) throw new Error(result.error.message);
        const staged = result.data as {identifier?: unknown; targetSeconds?: unknown; reportedSeconds?: unknown} | null;
        if (!staged || typeof staged.identifier !== 'string') throw new Error('Usage report claim returned an invalid batch');
        return {
          identifier: staged.identifier,
          targetSeconds: Number(staged.targetSeconds),
          reportedSeconds: Number(staged.reportedSeconds),
        };
      },
      async completeBatch(staged) {
        const result = await client.rpc('complete_usage_report', {
          p_organization_id: organizationId,
          p_period: reportPeriod,
          p_identifier: staged.identifier,
        });
        if (result.error) throw new Error(result.error.message);
      },
      async createMeterEvent(event) {
        await stripe!.createMeterEvent(event, {idempotencyKey: event.identifier});
      },
    });
    if (reportPeriod === period) meteredSecondsByOrganization.set(organizationId, report.seconds);
  });
  const ownerKeys = new Set((memberships.data ?? []).map((row) => `${String(row.organization_id)}:${String(row.user_id)}`));
  const preferenceByOrganization = new Map(
    (preferences.data ?? [])
      .filter((row) => ownerKeys.has(`${String(row.organization_id)}:${String(row.user_id)}`))
      .map((row) => [String(row.organization_id), row]),
  );
  const restaurantByOrganization = new Map((restaurants.data ?? []).map((row) => [String(row.organization_id), String(row.name)]));
  const recipients = (organizations.data ?? []).flatMap((organization): BillingAlertRecipient[] => {
    const organizationId = String(organization.id);
    const preference = preferenceByOrganization.get(organizationId);
    const restaurantName = restaurantByOrganization.get(organizationId);
    if (!preference || !restaurantName) return [];
    return [{
      organizationId,
      restaurantName,
      email: String(preference.email),
      locale: preference.locale === 'fr' ? 'fr' : 'en',
      lowBalance: Boolean(preference.low_balance),
      usedSeconds: meteredSecondsByOrganization.get(organizationId) ?? 0,
      bundleMinutes: bundleMinutes(String(organization.plan)),
      lastInvoiceStatus: organization.last_invoice_status === null ? null : String(organization.last_invoice_status),
      paymentFailedAt: organization.stripe_invoice_event_created_at === null ? null : String(organization.stripe_invoice_event_created_at),
    }];
  });
  return {
    recipients,
    billingFailures,
    async wasSent(key) {
      const value = parseAlertKey(key);
      const result = await client.from('usage_alerts_sent').select('id').match({organization_id: value.organizationId, period: value.period, threshold: value.threshold}).maybeSingle();
      if (result.error) throw new Error(result.error.message);
      return result.data !== null;
    },
    async markSent(key) {
      const value = parseAlertKey(key);
      const result = await client.from('usage_alerts_sent').upsert({organization_id: value.organizationId, period: value.period, threshold: value.threshold}, {onConflict: 'organization_id,period,threshold', ignoreDuplicates: true});
      if (result.error) throw new Error(result.error.message);
    },
  };
}

export async function GET(request: Request): Promise<Response> {
  const handler = createUsageAlertsCronHandler({
    secret: integrationValue('CRON_SECRET', 'mock-cron-secret'),
    async run() {
      const now = new Date();
      const period = now.toISOString().slice(0, 7);
      const repository = (process.env.DATA_SOURCE ?? 'mock') === 'mock'
        ? {recipients: [] as BillingAlertRecipient[], billingFailures: 0, wasSent: async () => false, markSent: async () => undefined}
        : await liveRecipients(period);
      const resend = createResendClient({apiKey: integrationValue('RESEND_API_KEY', 'mock-resend-key'), baseUrl: getProviderBaseUrl('resend')});
      const alerts = await runUsageAlerts({
        period, now, from: integrationValue('RESEND_FROM_EMAIL', 'Receptionist <alerts@example.test>'), ...repository,
        send: async (email) => { await sendOwnerNotification(email, (message, options) => resend.sendEmail(message, options)); },
      });
      return {...alerts, failed: alerts.failed + repository.billingFailures};
    },
  });
  return handler(request);
}
