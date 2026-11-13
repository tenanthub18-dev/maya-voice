export type BillingAlertLocale = 'en' | 'fr';

export interface BillingAlertRecipient {
  organizationId: string;
  restaurantName: string;
  email: string;
  locale: BillingAlertLocale;
  lowBalance: boolean;
  usedSeconds: number;
  bundleMinutes: number;
  lastInvoiceStatus: string | null;
  paymentFailedAt: string | null;
}

interface AlertEmail {
  type: 'low_balance' | 'payment_failed';
  locale: BillingAlertLocale;
  restaurantName: string;
  detail: string;
  recipient: string;
  from: string;
  eventId: string;
}

const GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

function usageDetail(locale: BillingAlertLocale, threshold: 80 | 100, period: string): string {
  return locale === 'fr'
    ? `Vous avez utilisé au moins ${threshold} % de vos minutes incluses pour ${period}.`
    : `You have used at least ${threshold}% of your included minutes for ${period}.`;
}

function paymentDetail(locale: BillingAlertLocale): string {
  return locale === 'fr'
    ? 'Le paiement a échoué. Mettez à jour le mode de paiement pendant le délai de grâce de 7 jours pour éviter le transfert des appels.'
    : 'Payment failed. Update the payment method during the 7-day grace period to prevent calls from being forwarded.';
}

export async function runUsageAlerts(input: {
  period: string;
  now: Date;
  from: string;
  recipients: BillingAlertRecipient[];
  wasSent: (key: string) => Promise<boolean>;
  markSent: (key: string) => Promise<void>;
  send: (email: AlertEmail) => Promise<void>;
}): Promise<{sent: number; failed: number}> {
  let sent = 0;
  let failed = 0;
  const day = input.now.toISOString().slice(0, 10);

  for (const recipient of input.recipients) {
    const utilization = recipient.bundleMinutes > 0
      ? recipient.usedSeconds / (recipient.bundleMinutes * 60)
      : 0;
    if (recipient.lowBalance) {
      for (const threshold of [80, 100] as const) {
        if (utilization < threshold / 100) continue;
        const key = `${recipient.organizationId}:${input.period}:${threshold}`;
        if (await input.wasSent(key)) continue;
        try {
          await input.send({
            type: 'low_balance', locale: recipient.locale, restaurantName: recipient.restaurantName,
            detail: usageDetail(recipient.locale, threshold, input.period), recipient: recipient.email,
            from: input.from, eventId: key,
          });
          await input.markSent(key);
          sent += 1;
        } catch {
          failed += 1;
        }
      }
    }

    const failedAt = recipient.paymentFailedAt ? Date.parse(recipient.paymentFailedAt) : Number.NaN;
    const age = input.now.getTime() - failedAt;
    if (recipient.lastInvoiceStatus === 'payment_failed' && Number.isFinite(failedAt) && age >= 0 && age < GRACE_MS) {
      const key = `${recipient.organizationId}:${input.period}:payment_failed:${day}`;
      if (!(await input.wasSent(key))) {
        try {
          await input.send({
            type: 'payment_failed', locale: recipient.locale, restaurantName: recipient.restaurantName,
            detail: paymentDetail(recipient.locale), recipient: recipient.email, from: input.from, eventId: key,
          });
          await input.markSent(key);
          sent += 1;
        } catch {
          failed += 1;
        }
      }
    }
  }
  return {sent, failed};
}
