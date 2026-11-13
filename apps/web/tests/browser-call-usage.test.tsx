// @vitest-environment jsdom
import {renderToStaticMarkup} from 'react-dom/server';
import {createTranslator, type AbstractIntlMessages} from 'next-intl';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import type {Call, DataSource} from '@/lib/data/types';
import {createMockDataSource, getMockSeed} from '@/lib/data/mock';
import en from '@/messages/en.json';
import fr from '@/messages/fr.json';
import {browserCall} from './fixtures/browser-call';

const runtime = vi.hoisted(() => ({source: null as DataSource | null, locale: 'en', dateOptions: [] as Intl.DateTimeFormatOptions[]}));
vi.mock('@/lib/data', () => ({getDataSource: () => runtime.source}));
vi.mock('@/lib/restaurant', () => ({getCurrentRestaurant: async () => runtime.source!.getRestaurant()}));
vi.mock('@/app/calls/[id]/actions', () => ({saveTeaching: vi.fn()}));
vi.mock('@/app/actions', () => ({setAgentEnabled: vi.fn()}));
vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({locale: runtime.locale, messages: (runtime.locale === 'fr' ? fr : en) as AbstractIntlMessages, namespace}),
  getFormatter: async () => ({number: (n: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(runtime.locale, options).format(n), dateTime: (d: Date, options?: Intl.DateTimeFormatOptions) => {
    runtime.dateOptions.push(options ?? {});
    return new Intl.DateTimeFormat(runtime.locale, {timeZone: 'UTC', ...options}).format(d);
  }}),
}));
import CallDetailPage from '@/app/calls/[id]/page';
import {CallsScreen, HomeScreen} from '@/components/dashboard-screen';

function rows(calls: Call[]) {
  runtime.source = {...createMockDataSource(), listCalls: vi.fn(async () => calls), listCallTurns: vi.fn(async () => []), listCallMetrics: vi.fn(async () => []), listBookings: vi.fn(async () => []), listOrders: vi.fn(async () => [])};
}
const detail = async () => renderToStaticMarkup(await CallDetailPage({params: Promise.resolve({id: 'browser-call'})}));
const list = async (searchParams = {}) => renderToStaticMarkup(await CallsScreen({searchParams}));
beforeEach(() => {runtime.locale = 'en'; runtime.dateOptions = []; rows([browserCall()]);});

describe('browser call rendering', () => {
  it('renders Toronto evening timestamps and keeps those calls in Today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:30:00.000Z'));
    try {
      rows([
        browserCall({startedAt: '2026-11-13T00:14:00.000Z', endedAt: '2026-11-13T00:15:05.000Z'}),
        browserCall({id: 'previous-day', startedAt: '2026-11-12T04:59:59.999Z'}),
      ]);
      const html = await list({date: 'today'});
      expect(html).toContain('Nov 12, 2026, 7:14 PM');
      expect(html).toContain('href="/calls/browser-call"');
      expect(html).not.toContain('href="/calls/previous-day"');
      expect(runtime.dateOptions).toEqual([{dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto'}]);
    } finally { vi.useRealTimers(); }
  });

  it.each(['en', 'fr'])('renders detail header, sidebar and linked timestamps in Toronto (%s)', async (locale) => {
    runtime.locale = locale;
    rows([browserCall({startedAt: '2026-11-13T00:14:00.000Z', endedAt: '2026-11-13T00:15:05.000Z'})]);
    const seed = getMockSeed();
    runtime.source!.listBookings = async () => [{...seed.bookings[0], callId: 'browser-call', startsAt: '2026-11-13T01:00:00.000Z'}];
    runtime.source!.listOrders = async () => [{...seed.orders[0], callId: 'browser-call', pickupAt: '2026-11-13T01:30:00.000Z'}];
    const html = await detail();
    if (locale === 'en') {
      for (const text of ['November 12, 2026 at 7:14 PM', 'Nov 12, 7:14 PM', 'Nov 12, 2026, 8:00 PM', '8:30 PM']) expect(html).toContain(text);
    } else {
      for (const text of ['12 novembre 2026 à 19:14', '12 nov., 19:14', '12 nov. 2026, 20:00', '20:30']) expect(html).toContain(text);
    }
    expect(runtime.dateOptions).toEqual([
      {dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Toronto'},
      {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Toronto'},
      {dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Toronto'},
      {timeStyle: 'short', timeZone: 'America/Toronto'},
    ]);
  });

  it('shows null callers as browser calls and elapsed timestamps alongside compact usage', async () => {
    const html = await list();
    expect(html).toContain('Browser test call');
    expect(html).toContain('1:05');
    expect(html).toContain('1,200');
    expect(html).toContain('USD');
    expect(html).toContain('0.0007');
    expect(html).toMatch(/partial/i);
    expect(html).not.toContain('•••');
    expect(html).not.toContain('null');
  });
  it('preserves legacy phone masking, duration and existing filters', async () => {
    const phone = {...getMockSeed().calls[0], id: 'phone-call', fromLast4: '4123', billableSeconds: 65};
    rows([browserCall(), phone]);
    const html = await list();
    expect(html).toContain('••• ••• 4123');
    expect(html.match(/1:05/g)).toHaveLength(2);
    expect(await list({outcome: 'transferred'})).not.toContain('Browser test call');
  });
  it('uses the current time for an ongoing browser call', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-12T12:02:10Z'));
    try { rows([browserCall({endedAt: null})]); expect(await list()).toContain('2:10'); }
    finally {vi.restoreAllMocks();}
  });
  it('localizes browser caller labels in the home review list', async () => {
    runtime.locale = 'fr'; rows([browserCall({qaFlags: ['incomplete']})]);
    expect(renderToStaticMarkup(await HomeScreen())).toContain('Appel test du navigateur');
  });
  it('renders actual model usage and known USD component estimates without adding cached tokens twice', async () => {
    const html = await detail();
    expect(html).toContain('Browser practice call. Orders and bookings were simulated.');
    for (const text of ['Usage and cost', 'Total LLM tokens', 'Input LLM tokens', 'Output LLM tokens', 'Cached input tokens', 'STT audio seconds', 'TTS characters', 'Generated audio seconds', '1,200', '1,000', '200', '400', 'actual-llm', 'actual-stt', 'actual-tts', '0.0006', '0.0001', '0.0007', 'USD']) expect(html).toContain(text);
    expect(html).not.toContain('1,600');
    expect(html).toContain('Known components only');
    expect(html).toContain('not a full invoice');
    expect(html).not.toContain('CAD');
    expect(html).toContain('1:05');
    expect(runtime.source!.listCallTurns).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, null])('does not turn absent usage or legacy currency-free costs into zero USD (%s)', async (usage) => {
    rows([browserCall({usage, costMicros: {llm: 4000}})]);
    const html = await detail();
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('0.0000');
    expect(html).not.toContain('USD');
    expect(html).not.toContain('actual-llm');
    const listHtml = await list();
    expect(listHtml).not.toContain('0.0000');
    expect(listHtml).toContain('Usage and cost unavailable');
  });
  it('marks incomplete sessions and unavailable services without fabricating costs', async () => {
    const call = browserCall(); call.usage!.usage_complete = false; call.usage!.cost_status = 'unavailable'; call.usage!.services.forEach((s) => {s.cost_micros = null;});
    rows([call]);
    const html = await detail();
    expect(html).toContain('Incomplete session');
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('0.0000');
  });
  it('renders French usage copy and escapes untrusted model text', async () => {
    const call = browserCall(); call.usage!.services[0].model = '<script>\u202Ealert(1)</script>';
    runtime.locale = 'fr'; rows([call]);
    const html = await detail();
    expect(html).toContain('Utilisation et coût');
    expect(html).toContain('Appel de pratique');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('\u202E');
    expect(html).not.toContain('<script>');
  });
});
