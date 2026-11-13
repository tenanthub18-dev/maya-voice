// @vitest-environment jsdom

import {performance} from 'node:perf_hooks';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, expect, test, vi} from 'vitest';
import type {CallMetric, CallTurn, DataSource} from '@/lib/data/types';

const runtime = vi.hoisted(() => ({source: null as DataSource | null}));

vi.mock('@/lib/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data')>();
  return {...actual, getDataSource: () => {
    if (!runtime.source) throw new Error('Performance fixture has no data source');
    return runtime.source;
  }};
});

const translate = (namespace: string) => (key: string, values?: Record<string, unknown>) =>
  `${namespace}.${key}${values ? `:${JSON.stringify(values)}` : ''}`;

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => translate(namespace),
  getFormatter: async () => ({
    number: (value: number) => String(value),
    dateTime: (value: Date) => value.toISOString(),
  }),
}));
vi.mock('@/app/calls/[id]/actions', () => ({saveTeaching: vi.fn()}));

beforeEach(() => { runtime.source = null; });

test('F13 renders a ten-minute 200-turn call under 2 seconds without N+1 reads', async () => {
  const {createMockDataSource} = await import('@/lib/data/mock');
  const base = createMockDataSource();
  const call = (await base.listCalls())[0]!;
  const stamp = '2026-10-27T12:00:00.000Z';
  const turns: CallTurn[] = Array.from({length: 200}, (_, index) => ({
    id: `performance-turn-${index}`,
    createdAt: stamp,
    updatedAt: stamp,
    callId: call.id,
    idx: index,
    speaker: index % 2 === 0 ? 'caller' : 'agent',
    language: 'en',
    text: `Transcript turn ${index} with enough content to represent a realistic ten-minute call.`,
    startedMs: index * 3_000,
    endedMs: index * 3_000 + 2_000,
    interrupted: false,
  }));
  const metrics: CallMetric[] = Array.from({length: 100}, (_, index) => ({
    id: `performance-metric-${index}`,
    createdAt: stamp,
    updatedAt: stamp,
    callId: call.id,
    turnIdx: index,
    eotMs: 90,
    sttMs: 110,
    llmTtftMs: 180,
    ttsTtfbMs: 160,
    totalMs: 540,
  }));
  const counts = new Map<string, number>();
  const source = new Proxy(base, {get(target, property, receiver) {
    const original = Reflect.get(target, property, receiver) as unknown;
    if (typeof original !== 'function') return original;
    return async (...args: unknown[]) => {
      const name = String(property);
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (name === 'listCallTurns') return turns;
      if (name === 'listCallMetrics') return metrics;
      return (original as (...values: unknown[]) => unknown)(...args);
    };
  }});
  runtime.source = source;
  const {default: CallDetailPage} = await import('@/app/calls/[id]/page');

  const renderPage = async () => renderToStaticMarkup(await CallDetailPage({
    params: Promise.resolve({id: call.id}),
  }));
  await renderPage();
  counts.clear();
  const started = performance.now();
  const html = await renderPage();
  const elapsedMs = performance.now() - started;

  console.info(`F13 call detail SSR: ${elapsedMs.toFixed(3)} ms, data-source calls=${JSON.stringify(Object.fromEntries(counts))}`);
  expect(elapsedMs).toBeLessThan(2_000);
  expect(html).toContain('Transcript turn 199');
  expect(Object.fromEntries(counts)).toEqual({
    listCalls: 1,
    getRestaurant: 1,
    listCallTurns: 1,
    listCallMetrics: 1,
    listBookings: 1,
    listOrders: 1,
  });
});
