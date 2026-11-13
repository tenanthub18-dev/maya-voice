import type {Call, Language} from '@/lib/data/types';
import {billableSeconds} from '@/lib/billing/billable-seconds';

export interface AnalyticsDateRange {
  from: string;
  to: string;
}

export interface AnalyticsAggregate {
  totalCalls: number;
  totalMinutes: number;
  totalCostMicros: number;
  outcomes: Record<Call['outcome'], number>;
  languages: Record<Language, number>;
  busiestHours: number[][];
  transfers: {attempts: number; successful: number; rate: number};
}

const outcomes: Call['outcome'][] = ['booking', 'order', 'message', 'answered', 'transferred'];
const languages: Language[] = ['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar'];
const weekdayIndex: Record<string, number> = {Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6};

export function aggregateAnalytics(calls: Call[], range: AnalyticsDateRange, timeZone: string): AnalyticsAggregate {
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
  const hourFormatter = new Intl.DateTimeFormat('en-US', {timeZone, weekday: 'short', hour: '2-digit', hourCycle: 'h23'});
  const selected = calls.filter((call) => {
    // Browser provider estimates are USD and never customer CAD/billable analytics.
    if (call.source === 'browser') return false;
    const date = localDateKey(new Date(call.startedAt), dateFormatter);
    return date >= range.from && date <= range.to;
  });
  const outcomeCounts = Object.fromEntries(outcomes.map((outcome) => [outcome, 0])) as Record<Call['outcome'], number>;
  const languageCounts = Object.fromEntries(languages.map((language) => [language, 0])) as Record<Language, number>;
  const busiestHours = Array.from({length: 7}, () => Array<number>(24).fill(0));

  let totalSeconds = 0;
  let totalCostMicros = 0;
  let transferAttempts = 0;
  let successfulTransfers = 0;

  for (const call of selected) {
    outcomeCounts[call.outcome] += 1;
    for (const language of new Set(call.languages)) languageCounts[language] += 1;
    totalSeconds += billableSeconds(call.billableSeconds);
    totalCostMicros += Object.values(call.costMicros).reduce((sum, cost) => sum + cost, 0);

    const parts = hourFormatter.formatToParts(new Date(call.startedAt));
    const weekday = weekdayIndex[part(parts, 'weekday')];
    const hour = Number(part(parts, 'hour'));
    if (weekday !== undefined && Number.isInteger(hour)) busiestHours[weekday][hour] += 1;

    if (call.outcome === 'transferred' || call.transferred) transferAttempts += 1;
    if (call.transferred) successfulTransfers += 1;
  }

  return {
    totalCalls: selected.length,
    totalMinutes: totalSeconds / 60,
    totalCostMicros,
    outcomes: outcomeCounts,
    languages: languageCounts,
    busiestHours,
    transfers: {
      attempts: transferAttempts,
      successful: successfulTransfers,
      rate: transferAttempts === 0 ? 0 : successfulTransfers / transferAttempts
    }
  };
}

function localDateKey(date: Date, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(date);
  return `${part(parts, 'year')}-${part(parts, 'month')}-${part(parts, 'day')}`;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((candidate) => candidate.type === type)?.value ?? '';
}
