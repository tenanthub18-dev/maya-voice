import {createHash} from 'node:crypto';

import {billableSeconds} from './billable-seconds';

interface UsageCall {
  id: string;
  durationSeconds: number;
  cachedBillableSeconds?: number;
}

interface UsageLedger {
  seconds: number;
  reportedSeconds: number;
  stripeReported: boolean;
  reportingIdentifier?: string | null;
  reportingSeconds?: number | null;
}

interface UsageBatch {
  identifier: string;
  targetSeconds: number;
  reportedSeconds: number;
}

interface MeterEvent {
  customerId: string;
  eventName: string;
  value: string;
  identifier: string;
}

interface PeriodLedger {
  period: string;
  seconds: number;
  reportedSeconds: number;
  stripeReported: boolean;
}

export function pendingUsagePeriods(ledgers: PeriodLedger[]): string[] {
  return ledgers
    .filter((ledger) => !ledger.stripeReported || ledger.reportedSeconds < ledger.seconds)
    .map((ledger) => ledger.period)
    .sort();
}

export async function runIsolatedUsageReports<T>(
  items: T[],
  report: (item: T) => Promise<void>,
): Promise<number> {
  let failed = 0;
  for (const item of items) {
    try {
      await report(item);
    } catch {
      failed += 1;
    }
  }
  return failed;
}

export async function reportUsageBatch(input: {
  organizationId: string;
  period: string;
  customerId: string;
  eventName: string;
  calls: UsageCall[];
  ledger: UsageLedger;
  stageBatch: (candidate: {identifier: string; targetSeconds: number}) => Promise<UsageBatch>;
  completeBatch: (batch: UsageBatch) => Promise<void>;
  createMeterEvent: (event: MeterEvent) => Promise<void>;
}): Promise<{seconds: number; quantity: number; identifier: string; reported: boolean}> {
  const batch = input.calls
    .map((call) => ({id: call.id, seconds: billableSeconds(call.durationSeconds, call.cachedBillableSeconds)}))
    .sort((left, right) => left.id.localeCompare(right.id));
  const seconds = batch.reduce((total, call) => total + call.seconds, 0);
  const digest = createHash('sha256')
    .update(batch.map((call) => `${call.id}:${call.seconds}`).join(','))
    .digest('hex')
    .slice(0, 24);
  const identifier = `usage:${input.organizationId}:${input.period}:${digest}`;

  if (!Number.isSafeInteger(input.ledger.reportedSeconds) || input.ledger.reportedSeconds < 0 || input.ledger.reportedSeconds > seconds) {
    throw new Error('Reported usage seconds cannot exceed the call batch total');
  }
  const quantity = seconds - input.ledger.reportedSeconds;

  if (quantity === 0) {
    return {seconds, quantity, identifier, reported: false};
  }

  const staged = await input.stageBatch({identifier, targetSeconds: seconds});
  if (!Number.isSafeInteger(staged.targetSeconds)
    || !Number.isSafeInteger(staged.reportedSeconds)
    || staged.targetSeconds <= staged.reportedSeconds) {
    throw new Error('Staged usage batch has invalid reporting bounds');
  }
  const stagedQuantity = staged.targetSeconds - staged.reportedSeconds;
  await input.createMeterEvent({
    customerId: input.customerId,
    eventName: input.eventName,
    value: String(stagedQuantity),
    identifier: staged.identifier,
  });
  await input.completeBatch(staged);
  return {seconds, quantity: stagedQuantity, identifier: staged.identifier, reported: true};
}
