import {describe, expect, it} from 'vitest';
import {applyCallFilters, calculateLatencySummary, formatDuration, maskCaller, parseCallFilters, percentile} from '@/lib/calls';
import {getMockSeed} from '@/lib/data/mock';

describe('call list logic', () => {
  it('normalizes unsupported query values instead of hiding calls', () => {
    expect(parseCallFilters({date: 'yesterday', outcome: 'lost', language: 'es', flagged: 'maybe'})).toEqual({
      date: 'all', outcome: 'all', language: 'all', flagged: false
    });
  });

  it('combines date, outcome, language, and flagged filters', () => {
    const result = applyCallFilters(getMockSeed().calls, {
      date: 'today', outcome: 'transferred', language: 'en', flagged: true
    }, '2026-10-27');

    expect(result.map((call) => call.id)).toEqual(['call-001']);
  });

  it('uses Toronto civil dates for Today across the UTC evening rollover', () => {
    const calls = [
      ['before-midnight', '2026-11-12T04:59:59.999Z'],
      ['midnight', '2026-11-12T05:00:00.000Z'],
      ['evening', '2026-11-13T00:14:00.000Z'],
      ['last-millisecond', '2026-11-13T04:59:59.999Z'],
      ['tomorrow', '2026-11-13T05:00:00.000Z'],
    ].map(([id, startedAt]) => ({...getMockSeed().calls[0], id, startedAt}));
    const filters = parseCallFilters({date: 'today'});
    expect(applyCallFilters(calls, filters, '2026-11-12', 'America/Toronto').map((call) => call.id))
      .toEqual(['midnight', 'evening', 'last-millisecond']);
    // Omitting the zone retains the existing UTC helper contract.
    expect(applyCallFilters(calls, filters, '2026-11-12').map((call) => call.id))
      .toEqual(['before-midnight', 'midnight']);
  });

  it.each([
    ['7d', '2026-11-04', '2026-10-29T04:00:00.000Z', '2026-11-05T05:00:00.000Z'],
    ['30d', '2026-11-12', '2026-10-14T04:00:00.000Z', '2026-11-13T05:00:00.000Z'],
    ['7d', '2026-03-10', '2026-03-04T05:00:00.000Z', '2026-03-11T04:00:00.000Z'],
    ['30d', '2026-03-20', '2026-02-19T05:00:00.000Z', '2026-03-21T04:00:00.000Z'],
  ])('includes both civil-date boundaries for %s ending %s across DST', (date, today, start, end) => {
    const calls = [
      ['before-start', new Date(Date.parse(start) - 1).toISOString()],
      ['at-start', start],
      ['before-end', new Date(Date.parse(end) - 1).toISOString()],
      ['at-end', end],
    ].map(([id, startedAt]) => ({...getMockSeed().calls[0], id, startedAt}));
    expect(applyCallFilters(calls, parseCallFilters({date}), today, 'America/Toronto').map((call) => call.id))
      .toEqual(['at-start', 'before-end']);
  });

  it.each([['7d', '2026-11-06'], ['30d', '2026-10-14']])('keeps default UTC %s boundaries inclusive', (date, start) => {
    const calls = [
      ['before', `${start}T00:00:00.000Z`, -1],
      ['start', `${start}T00:00:00.000Z`, 0],
      ['end', '2026-11-13T00:00:00.000Z', -1],
      ['after', '2026-11-13T00:00:00.000Z', 0],
    ].map(([id, stamp, offset]) => ({...getMockSeed().calls[0], id: String(id), startedAt: new Date(Date.parse(String(stamp)) + Number(offset)).toISOString()}));
    expect(applyCallFilters(calls, parseCallFilters({date}), '2026-11-12').map((call) => call.id))
      .toEqual(['start', 'end']);
  });

  it('masks callers and formats durations without exposing the stored hash', () => {
    expect(maskCaller('4123')).toBe('••• ••• 4123');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(3605)).toBe('1:00:05');
  });
});

describe('latency calculations', () => {
  it('uses nearest-rank percentiles at the lower and upper boundaries', () => {
    expect(percentile([100, 200, 300, 400], 50)).toBe(200);
    expect(percentile([100, 200, 300, 400], 95)).toBe(400);
    expect(percentile([], 95)).toBeNull();
  });

  it('summarizes every recorded latency stage and compares total to its budgets', () => {
    const summary = calculateLatencySummary(getMockSeed().callMetrics.filter((row) => row.callId === 'call-001'));

    expect(summary.map((row) => row.key)).toEqual(['eot', 'stt', 'llm', 'tts', 'total']);
    expect(summary.at(-1)).toEqual({key: 'total', p50: 680, p95: 1120, p50WithinBudget: true, p95WithinBudget: false});
  });
});
