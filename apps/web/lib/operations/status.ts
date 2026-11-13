export interface OperationalStatusInput {
  now: Date;
  timeZone: string;
  transferHours: Record<string, string>;
  restaurantPaused: boolean;
  agentEnabled: boolean;
  spendAllowed: boolean;
  lastInvoiceStatus?: string | null;
  stripeInvoiceEventCreatedAt?: string | null;
}

const PAYMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1_000;

function minutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
}

export function resolveTransferWindow(transferHours: Record<string, string>): {start: string; end: string} {
  const daily = (transferHours.daily ?? '').split('-');
  return {
    start: transferHours.start ?? daily[0] ?? '',
    end: transferHours.end ?? daily[1] ?? '',
  };
}

export function isTransferOpen(now: Date, timeZone: string, transferHours: Record<string, string>): boolean {
  const {start: startText, end: endText} = resolveTransferWindow(transferHours);
  const start = minutes(startText ?? '');
  const end = minutes(endText ?? '');
  if (start === null || end === null || start === end) return false;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return false;
  const current = hour * 60 + minute;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export function getOperationalStatus(input: OperationalStatusInput) {
  const payment = getPaymentStatus(input.now, input.lastInvoiceStatus, input.stripeInvoiceEventCreatedAt);
  return {
    agentPaused: input.restaurantPaused || !input.agentEnabled,
    spendBlocked: !input.spendAllowed,
    ...payment,
    transferClosed: !isTransferOpen(input.now, input.timeZone, input.transferHours),
  };
}

export function getPaymentStatus(now: Date, lastInvoiceStatus?: string | null, stripeInvoiceEventCreatedAt?: string | null) {
  const paymentFailed = lastInvoiceStatus === 'payment_failed';
  const failedAt = stripeInvoiceEventCreatedAt
    ? Date.parse(stripeInvoiceEventCreatedAt)
    : Number.NaN;
  const age = now.getTime() - failedAt;
  const inGrace = paymentFailed && Number.isFinite(failedAt)
    && age >= 0 && age < PAYMENT_GRACE_MS;
  return {
    paymentGrace: inGrace,
    paymentBlocked: paymentFailed && !inGrace,
  };
}
