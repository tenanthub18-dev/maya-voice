import {describe, expect, test} from 'vitest';
import {aggregateAnalytics} from '@/lib/analytics';
import type {Call} from '@/lib/data/types';

const stamp = '2026-10-27T12:00:00.000Z';

function call(overrides: Partial<Call> & Pick<Call, 'id' | 'startedAt'>): Call {
  const {id, startedAt, ...rest} = overrides;
  return {
    id,
    createdAt: stamp,
    updatedAt: stamp,
    restaurantId: 'restaurant-1',
    agentVersionId: 'version-1',
    telnyxCallId: `provider-${overrides.id}`,
    fromE164Hash: `hash-${overrides.id}`,
    fromLast4: '1234',
    startedAt,
    endedAt: startedAt,
    billableSeconds: 60,
    outcome: 'answered',
    languages: ['en'],
    transferred: false,
    recordingPath: null,
    summary: 'Fixture call',
    qaFlags: [],
    costMicros: {},
    ...rest
  };
}

describe('aggregateAnalytics', () => {
  test('excludes browser practice calls and USD provider costs from customer CAD analytics', () => {
    const result = aggregateAnalytics([
      call({id: 'phone', startedAt: stamp, costMicros: {llm: 1000}}),
      call({id: 'browser', startedAt: stamp, source: 'browser', billableSeconds: 0, costMicros: {llm: 9000}}),
    ], {from: '2026-10-27', to: '2026-10-27'}, 'America/Toronto');
    expect(result.totalCostMicros).toBe(1000);
    expect(result.totalCalls).toBe(1);
    expect(result.totalMinutes).toBe(1);
    expect(result.outcomes.answered).toBe(1);
  });

  test('uses inclusive restaurant-local date bounds and exact usage totals', () => {
    const calls = [
      call({id: 'before', startedAt: '2026-10-26T03:59:00.000Z', billableSeconds: 900, costMicros: {stt: 9_000_000}}),
      call({id: 'start', startedAt: '2026-10-26T04:00:00.000Z', billableSeconds: 90, costMicros: {stt: 100_000, tts: 200_000}}),
      call({id: 'end', startedAt: '2026-10-28T03:59:00.000Z', billableSeconds: 30, costMicros: {llm: 50_000}}),
      call({id: 'after', startedAt: '2026-10-28T04:00:00.000Z', billableSeconds: 900, costMicros: {stt: 9_000_000}})
    ];

    const result = aggregateAnalytics(calls, {from: '2026-10-26', to: '2026-10-27'}, 'America/Toronto');

    expect(result.totalCalls).toBe(2);
    expect(result.totalMinutes).toBe(2);
    expect(result.totalCostMicros).toBe(350_000);
  });

  test('rounds every call independently before computing minutes', () => {
    const result = aggregateAnalytics([
      call({id: 'one', startedAt: '2026-10-27T12:00:00.000Z', billableSeconds: 1}),
      call({id: 'seven', startedAt: '2026-10-27T13:00:00.000Z', billableSeconds: 7}),
    ], {from: '2026-10-27', to: '2026-10-27'}, 'America/Toronto');
    expect(result.totalMinutes).toBe(18 / 60);
  });

  test('counts outcomes and every language represented by a call', () => {
    const calls = [
      call({id: 'one', startedAt: '2026-10-27T12:00:00.000Z', outcome: 'booking', languages: ['en', 'pa']}),
      call({id: 'two', startedAt: '2026-10-27T13:00:00.000Z', outcome: 'booking', languages: ['pa']}),
      call({id: 'three', startedAt: '2026-10-27T14:00:00.000Z', outcome: 'message', languages: ['fr-CA']})
    ];

    const result = aggregateAnalytics(calls, {from: '2026-10-27', to: '2026-10-27'}, 'America/Toronto');

    expect(result.outcomes).toEqual({booking: 2, order: 0, message: 1, answered: 0, transferred: 0});
    expect(result.languages).toEqual({'en': 1, 'en-IN': 0, 'fr-CA': 1, ur: 0, hi: 0, pa: 2, te: 0, ar: 0});
  });

  test('places calls into a seven-by-24 local-hour matrix', () => {
    const calls = [call({id: 'monday-evening', startedAt: '2026-10-27T00:30:00.000Z'})];

    const result = aggregateAnalytics(calls, {from: '2026-10-26', to: '2026-10-26'}, 'America/Toronto');

    expect(result.busiestHours).toHaveLength(7);
    expect(result.busiestHours.every((day) => day.length === 24)).toBe(true);
    expect(result.busiestHours[1][20]).toBe(1);
    expect(result.busiestHours.flat().reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  test('distinguishes transfer attempts from successful transfers', () => {
    const calls = [
      call({id: 'success', startedAt: '2026-10-27T12:00:00.000Z', outcome: 'transferred', transferred: true}),
      call({id: 'failed', startedAt: '2026-10-27T13:00:00.000Z', outcome: 'transferred', transferred: false}),
      call({id: 'answered', startedAt: '2026-10-27T14:00:00.000Z'})
    ];

    const result = aggregateAnalytics(calls, {from: '2026-10-27', to: '2026-10-27'}, 'America/Toronto');

    expect(result.transfers).toEqual({attempts: 2, successful: 1, rate: 0.5});
  });

  test('returns a zero rate when there were no transfer attempts', () => {
    const result = aggregateAnalytics(
      [call({id: 'answered', startedAt: '2026-10-27T14:00:00.000Z'})],
      {from: '2026-10-27', to: '2026-10-27'},
      'America/Toronto'
    );

    expect(result.transfers).toEqual({attempts: 0, successful: 0, rate: 0});
  });

  test('matches raw call rows for headline, funnel, language, transfer, and heat-map numbers', () => {
    const raw = [
      call({id: 'booking', startedAt: '2026-10-26T14:00:00.000Z', outcome: 'booking', languages: ['en'], billableSeconds: 61}),
      call({id: 'order', startedAt: '2026-10-26T14:30:00.000Z', outcome: 'order', languages: ['fr-CA', 'en'], billableSeconds: 119}),
      call({id: 'message', startedAt: '2026-10-27T01:00:00.000Z', outcome: 'message', languages: ['ur'], billableSeconds: 60}),
      call({id: 'transfer-ok', startedAt: '2026-10-27T02:00:00.000Z', outcome: 'transferred', languages: ['pa'], transferred: true, billableSeconds: 30}),
      call({id: 'transfer-failed', startedAt: '2026-10-27T02:30:00.000Z', outcome: 'transferred', languages: ['hi'], transferred: false, billableSeconds: 30}),
    ];

    const result = aggregateAnalytics(raw, {from: '2026-10-26', to: '2026-10-26'}, 'America/Toronto');

    expect(result.totalCalls).toBe(5);
    expect(result.totalMinutes).toBe(306 / 60);
    expect(result.outcomes).toEqual({booking: 1, order: 1, message: 1, answered: 0, transferred: 2});
    expect(result.languages).toEqual({'en': 2, 'en-IN': 0, 'fr-CA': 1, ur: 1, hi: 1, pa: 1, te: 0, ar: 0});
    expect(result.transfers).toEqual({attempts: 2, successful: 1, rate: 0.5});
    expect(result.busiestHours[1][10]).toBe(2);
    expect(result.busiestHours[1][21]).toBe(1);
    expect(result.busiestHours[1][22]).toBe(2);
    expect(result.busiestHours.flat().reduce((sum, count) => sum + count, 0)).toBe(raw.length);
  });
});
