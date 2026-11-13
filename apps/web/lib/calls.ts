import type {Call, CallCostStatus, CallMetric, CallUsageService, CallUsageTotals, Language} from './data/types';

export type CallDateFilter = 'all' | 'today' | '7d' | '30d';
export type CallOutcomeFilter = 'all' | Call['outcome'];
export type CallLanguageFilter = 'all' | Language;

export interface CallFilters {
  date: CallDateFilter;
  outcome: CallOutcomeFilter;
  language: CallLanguageFilter;
  flagged: boolean;
}

type QueryValue = string | string[] | undefined;
type Query = Record<string, QueryValue>;

const dateFilters = new Set<CallDateFilter>(['all', 'today', '7d', '30d']);
const outcomeFilters = new Set<CallOutcomeFilter>(['all', 'booking', 'order', 'message', 'answered', 'transferred']);
const languageFilters = new Set<CallLanguageFilter>(['all', 'en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar']);

function scalar(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function parseCallFilters(query: Query): CallFilters {
  const date = scalar(query.date);
  const outcome = scalar(query.outcome);
  const language = scalar(query.language);
  return {
    date: dateFilters.has(date as CallDateFilter) ? date as CallDateFilter : 'all',
    outcome: outcomeFilters.has(outcome as CallOutcomeFilter) ? outcome as CallOutcomeFilter : 'all',
    language: languageFilters.has(language as CallLanguageFilter) ? language as CallLanguageFilter : 'all',
    flagged: scalar(query.flagged) === 'true'
  };
}

export function applyCallFilters(calls: Call[], filters: CallFilters, today: string, timeZone = 'UTC'): Call[] {
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const days = filters.date === '7d' ? 7 : filters.date === '30d' ? 30 : null;
  // Subtract civil calendar days, not elapsed hours across a DST transition.
  const firstDate = days === null ? today : new Date(todayMs - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  // https://tc39.es/ecma402/#sec-intl.datetimeformat.prototype.formattoparts
  const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'});
  return calls.filter((call) => {
    const parts = filters.date === 'all' ? [] : dateFormat.formatToParts(new Date(call.startedAt));
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? '';
    const callDate = `${part('year')}-${part('month')}-${part('day')}`;
    const inDateRange = filters.date === 'all'
      || (filters.date === 'today' && callDate === today)
      || (days !== null && callDate >= firstDate && callDate <= today);
    return inDateRange
      && (filters.outcome === 'all' || call.outcome === filters.outcome)
      && (filters.language === 'all' || call.languages.includes(filters.language))
      && (!filters.flagged || call.qaFlags.length > 0);
  });
}

export function maskCaller(last4: string | null): string {
  return last4 ? `••• ••• ${last4}` : '••• •••';
}

export function callCallerLabel(call: Call, browserLabel: string): string {
  return call.source === 'browser' ? browserLabel : maskCaller(call.fromLast4);
}

export function getCallDurationSeconds(call: Call, now = Date.now()): number {
  if (call.source !== 'browser') return call.billableSeconds;
  const seconds = ((call.endedAt ? Date.parse(call.endedAt) : now) - Date.parse(call.startedAt)) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
}

export interface CallUsageSummary {
  status: CallCostStatus;
  costMicros: number | null;
  totals: CallUsageTotals | null;
  services: CallUsageService[];
  incomplete: boolean;
  rateAsOf: string | null;
}

function knownAmount(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function getCallUsageSummary(call: Call): CallUsageSummary {
  const usage = call.usage;
  const unavailable: CallUsageSummary = {status: 'unavailable', costMicros: null, totals: null, services: [], incomplete: false, rateAsOf: null};
  if (!usage || usage.schema_version !== 1) return unavailable;
  const totals = Object.fromEntries(Object.entries(usage.totals).map(([key, value]) => [key, knownAmount(value)])) as unknown as CallUsageTotals;
  const services = usage.services.map((service) => ({...service, cost_micros: usage.currency === 'USD' && usage.cost_status !== 'unavailable' ? knownAmount(service.cost_micros) : null}));
  const priced = services.filter((service) => service.cost_micros !== null);
  const costMicros = priced.length ? priced.reduce((sum, service) => sum + service.cost_micros!, 0) : null;
  const kinds = new Set(services.map((service) => service.kind));
  const complete = usage.usage_complete && priced.length === services.length && ['stt', 'tts', 'llm'].every((kind) => kinds.has(kind as CallUsageService['kind']));
  return {
    status: costMicros === null ? 'unavailable' : usage.cost_status === 'estimated' && complete ? 'estimated' : 'partial',
    costMicros, totals, services, incomplete: !usage.usage_complete, rateAsOf: usage.rate_as_of,
  };
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

export function percentile(values: number[], requested: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((Math.min(100, Math.max(0, requested)) / 100) * sorted.length));
  return sorted[rank - 1];
}

export type LatencyKey = 'eot' | 'stt' | 'llm' | 'tts' | 'total';
export interface LatencySummary {
  key: LatencyKey;
  p50: number | null;
  p95: number | null;
  p50WithinBudget: boolean | null;
  p95WithinBudget: boolean | null;
}

export function calculateLatencySummary(metrics: CallMetric[]): LatencySummary[] {
  const stages: Array<[LatencyKey, (metric: CallMetric) => number]> = [
    ['eot', (metric) => metric.eotMs],
    ['stt', (metric) => metric.sttMs],
    ['llm', (metric) => metric.llmTtftMs],
    ['tts', (metric) => metric.ttsTtfbMs],
    ['total', (metric) => metric.totalMs]
  ];
  return stages.map(([key, select]) => {
    const values = metrics.map(select);
    const p50 = percentile(values, 50);
    const p95 = percentile(values, 95);
    return {
      key,
      p50,
      p95,
      p50WithinBudget: key === 'total' && p50 !== null ? p50 < 700 : null,
      p95WithinBudget: key === 'total' && p95 !== null ? p95 < 1100 : null
    };
  });
}
