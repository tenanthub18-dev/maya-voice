// @vitest-environment jsdom

import {createHmac} from 'node:crypto';
import {readdirSync} from 'node:fs';
import {dirname, join, relative, sep} from 'node:path';
import {cloneElement, createElement, isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';

import type {DataSource} from '@/lib/data/types';
import {createPaymentLinkHandler} from '@/app/api/payments/link/_lib';
import {MockApiRepository} from '@/lib/api/mock-repository';
import {createStripeWebhookHandler} from '@/lib/api/webhooks';
import {signWorkerRequest} from '@/lib/security/worker-hmac';

const root = process.cwd();
const appRoot = join(root, 'app');
const runtime = vi.hoisted(() => ({source: null as DataSource | null}));

vi.mock('@/lib/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/data')>();
  return {...actual, getDataSource: () => {
    if (!runtime.source) throw new Error('Route-state fixture has no data source');
    return runtime.source;
  }};
});

const translate = (namespace: string) => (key: string, values?: Record<string, unknown>) =>
  `${namespace}.${key}${values ? `:${JSON.stringify(values)}` : ''}`;
const formatter = {number: (value: number) => String(value), dateTime: (value: Date) => value.toISOString()};

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => translate(namespace),
  getFormatter: async () => formatter,
  getLocale: async () => 'en',
}));
vi.mock('next-intl', () => ({useTranslations: (namespace: string) => translate(namespace)}));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NOT_FOUND'); },
  redirect: (target: string) => { throw new Error(`REDIRECT:${target}`); },
  useRouter: () => ({push: vi.fn(), replace: vi.fn(), refresh: vi.fn()}),
}));
vi.mock('@/lib/auth/guards', () => ({requireCapability: vi.fn(async () => ({id: 'owner'}))}));
vi.mock('@/lib/auth/server', () => ({createServerAuthProvider: async () => ({
  getUser: async () => ({id: 'owner', email: 'owner@example.com', role: 'owner', organizationId: 'organization-001'}),
})}));

type Route = '/' | '/admin' | '/agent' | '/analytics' | '/billing/cancel' | '/billing/success' | '/demo'
  | '/bookings' | '/calls' | '/calls/[id]' | '/home' | '/invite/accept' | '/login'
  | '/onboarding/[step]' | '/orders' | '/phone' | '/settings' | '/signup';
type PageModule = {default: (props: never) => ReactNode | Promise<ReactNode>};
type EmptyContract = {kind: 'not-applicable'} | {kind: 'data'; marker: string; configure(source: DataSource): DataSource};

interface RouteContract {
  load(): Promise<PageModule>;
  props(source: DataSource, empty: boolean): Promise<Record<string, unknown>> | Record<string, unknown>;
  empty: EmptyContract;
}

function override(source: DataSource, methods: Partial<DataSource>): DataSource {
  return new Proxy(source, {get(target, property, receiver) {
    if (property in methods) return methods[property as keyof DataSource];
    return Reflect.get(target, property, receiver);
  }});
}

const none = () => ({kind: 'not-applicable'} as const);
const data = (marker: string, methods: Partial<DataSource>) => ({
  kind: 'data' as const, marker, configure: (source: DataSource) => override(source, methods),
});
const noProps = () => ({});
const searchProps = () => ({searchParams: Promise.resolve({})});

const contracts: Record<Route, RouteContract> = {
  '/demo': {load: () => import('@/app/demo/page'), props: noProps, empty: none()},
  '/': {load: () => import('@/app/page'), props: noProps, empty: none()},
  '/admin': {load: () => import('@/app/admin/page'), props: searchProps, empty: data('screens.admin.noRestaurants', {listAdminRestaurants: async () => [], listAuditLogs: async () => []})},
  '/agent': {load: () => import('@/app/agent/page'), props: searchProps, empty: data('screens.agent.empty', {listAgentVersions: async () => []})},
  '/analytics': {load: () => import('@/app/analytics/page'), props: searchProps, empty: data('screens.analytics.empty', {listCalls: async () => []})},
  '/billing/cancel': {load: () => import('@/app/billing/cancel/page'), props: noProps, empty: none()},
  '/billing/success': {load: () => import('@/app/billing/success/page'), props: noProps, empty: none()},
  '/bookings': {load: () => import('@/app/bookings/page'), props: searchProps, empty: data('screens.bookings.empty', {listBookings: async () => []})},
  '/calls': {load: () => import('@/app/calls/page'), props: searchProps, empty: data('screens.calls.empty', {listCalls: async () => []})},
  '/calls/[id]': {
    load: () => import('@/app/calls/[id]/page'),
    props: async (source, empty) => ({params: Promise.resolve({id: empty ? 'missing-call' : (await source.listCalls())[0]!.id})}),
    empty: data('screens.callDetail.empty', {}),
  },
  '/home': {load: () => import('@/app/home/page'), props: noProps, empty: data('screens.home.empty', {listCalls: async () => []})},
  '/invite/accept': {load: () => import('@/app/invite/accept/page'), props: () => ({searchParams: Promise.resolve({})}), empty: none()},
  '/login': {load: () => import('@/app/login/page'), props: searchProps, empty: none()},
  '/onboarding/[step]': {
    load: () => import('@/app/onboarding/[step]/page'), props: () => ({params: Promise.resolve({step: '3'})}),
    empty: data('screens.onboarding.review.emptyMenu', {listHours: async () => [], listMenuItems: async () => [], listFaqs: async () => []}),
  },
  '/orders': {load: () => import('@/app/orders/page'), props: searchProps, empty: data('screens.orders.empty', {listOrders: async () => []})},
  '/phone': {load: () => import('@/app/phone/page'), props: noProps, empty: data('screens.phone.empty', {getPhoneNumber: async () => null})},
  '/settings': {load: () => import('@/app/settings/page'), props: noProps, empty: data('screens.settings.empty', {getOrganization: async () => null as never})},
  '/signup': {load: () => import('@/app/signup/page'), props: noProps, empty: none()},
};

function filesNamed(directory: string, name: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return filesNamed(path, name);
    return entry.isFile() && entry.name === name ? [path] : [];
  });
}

function routeForPage(page: string): string {
  const directory = relative(appRoot, dirname(page)).split(sep).filter(Boolean);
  return directory.length ? `/${directory.join('/')}` : '/';
}

async function resolveAsyncComponents(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsyncComponents));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<Record<string, unknown>>;
  if (typeof element.type === 'function' && element.type.constructor.name === 'AsyncFunction') {
    const render = element.type as (props: Record<string, unknown>) => Promise<ReactNode>;
    return resolveAsyncComponents(await render(element.props));
  }
  const children = await resolveAsyncComponents(element.props.children as ReactNode);
  return cloneElement(element, element.props, children);
}

async function renderRoute(route: Route, source: DataSource, empty: boolean): Promise<string> {
  runtime.source = source;
  const contract = contracts[route];
  const page = await contract.load();
  const props = await contract.props(source, empty);
  const output = await page.default(props as never);
  return renderToStaticMarkup(await resolveAsyncComponents(output));
}

describe('App Router state coverage', () => {
  it('enumerates every page and explicitly classifies empty-state applicability', () => {
    const routes = filesNamed(appRoot, 'page.tsx').map(routeForPage).sort();
    expect(routes).toEqual(Object.keys(contracts).sort());
    expect(Object.values(contracts).every(({empty}) => ['data', 'not-applicable'].includes(empty.kind))).toBe(true);
  });

  it.each(Object.entries(contracts) as [Route, RouteContract][])('%s renders its actual filled page', async (route, contract) => {
    const {createMockDataSource} = await import('@/lib/data/mock');
    const source = createMockDataSource();
    const html = await renderRoute(route, source, false);
    expect(html.length).toBeGreaterThan(80);
    if (contract.empty.kind === 'data') expect(html).not.toContain(contract.empty.marker);
    if (route === '/home') expect(html).toContain('operational.forwardingTitle');
  });

  it('shows the localized paid state on booking rows', async () => {
    const {createMockDataSource} = await import('@/lib/data/mock');
    runtime.source = createMockDataSource();
    const page = await contracts['/bookings'].load();
    const output = await page.default({searchParams: Promise.resolve({view: 'list'})} as never);
    expect(renderToStaticMarkup(await resolveAsyncComponents(output))).toContain('common.paid');
  });

  it('opens the voice-test tab when live policy storage is unsupported', async () => {
    const {createMockDataSource} = await import('@/lib/data/mock');
    const listPolicies = vi.fn(async () => { throw new Error('Policies are unsupported in live mode'); });
    runtime.source = override(createMockDataSource(), {listPolicies});
    const page = await contracts['/agent'].load();
    const output = await page.default({searchParams: Promise.resolve({tab: 'testCall'})} as never);
    expect(renderToStaticMarkup(await resolveAsyncComponents(output))).toContain('screens.agent.testCall.start');
    expect(listPolicies).not.toHaveBeenCalled();
  });

  it('lets long agent-version diff values shrink within the mobile page', async () => {
    const {createMockDataSource} = await import('@/lib/data/mock');
    runtime.source = createMockDataSource();
    const page = await contracts['/agent'].load();
    const output = await page.default({searchParams: Promise.resolve({tab: 'versions'})} as never);
    document.body.innerHTML = renderToStaticMarkup(await resolveAsyncComponents(output));

    const values = [...document.querySelectorAll('pre')];
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value.className).toContain('[overflow-wrap:anywhere]');
      expect(value.parentElement?.className).toContain('min-w-0');
    }
  });

  it('moves the dev mock from payment-link tool boundary to a paid badge synchronously', async () => {
    const {createMockDataSource} = await import('@/lib/data/mock');
    const source = createMockDataSource();
    runtime.source = source;
    const restaurant = await source.getRestaurant();
    const booking = (await source.listBookings()).find((row) => row.paidStatus === 'unpaid')!;
    const repository = new MockApiRepository(() => source);
    await source.setFeatureFlag('diner_payments', restaurant.id, true);
    await repository.setRestaurantConnectedAccount(restaurant.id, 'acct_mock_connected');
    const started = Date.now();

    const linkBody = JSON.stringify({
      restaurant_id: restaurant.id, call_id: 'call-e2e', booking_id: booking.id,
    });
    const timestamp = '1800000000';
    const path = '/api/payments/link';
    const {signature} = signWorkerRequest({secret: 'worker-secret', timestamp, method: 'POST', path, body: linkBody});
    const linkResponse = await createPaymentLinkHandler({
      repository,
      stripe: {createConnectedPaymentLink: async () => ({url: 'https://buy.stripe.test/mock'})},
      secret: 'worker-secret',
      nowSeconds: () => Number(timestamp),
      isEnabled: (id) => repository.isDinerPaymentsEnabled(id),
    })(new Request(`https://app.test${path}`, {
      method: 'POST', body: linkBody, headers: {'x-timestamp': timestamp, 'x-signature': signature},
    }));
    expect(linkResponse.status).toBe(200);

    const event = {
      id: 'evt_mock_paid', type: 'payment_intent.succeeded', created: Number(timestamp) - 1,
      account: 'acct_mock_connected', data: {object: {metadata: {booking_id: booking.id}}},
    };
    const webhookRequest = () => {
      const raw = JSON.stringify(event);
      const digest = createHmac('sha256', 'whsec_test').update(`${timestamp}.${raw}`).digest('hex');
      return new Request('https://app.test/api/webhooks/stripe', {
        method: 'POST', body: raw, headers: {'stripe-signature': `t=${timestamp},v1=${digest}`},
      });
    };
    const webhook = createStripeWebhookHandler({
      repository, limiter: {consume: () => ({allowed: true, retryAfterSeconds: 0})},
      secret: 'whsec_test', nowSeconds: () => Number(timestamp),
    });
    expect((await webhook(webhookRequest())).status).toBe(200);
    await expect(webhook(webhookRequest()).then((response) => response.json())).resolves.toEqual({received: true, duplicate: true});
    expect((await source.listBookings()).find((row) => row.id === booking.id)?.paidStatus).toBe('paid');

    const page = await contracts['/bookings'].load();
    const output = await page.default({searchParams: Promise.resolve({view: 'list'})} as never);
    const html = renderToStaticMarkup(await resolveAsyncComponents(output));
    expect(html).toMatch(new RegExp(`<strong>${booking.name}</strong>.*common\\.paid`, 'u'));
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it.each((Object.entries(contracts) as [Route, RouteContract][]).filter(([, contract]) => contract.empty.kind === 'data'))(
    '%s renders its actual empty-data path',
    async (route, contract) => {
      const {createMockDataSource} = await import('@/lib/data/mock');
      const empty = contract.empty as Extract<EmptyContract, {kind: 'data'}>;
      const source = empty.configure(createMockDataSource());
      expect(await renderRoute(route, source, true)).toContain(empty.marker);
    },
  );

  it.each((Object.entries(contracts) as [Route, RouteContract][]).filter(([, contract]) => contract.empty.kind === 'not-applicable'))(
    '%s declares empty state not applicable because it has no collection data',
    (_route, contract) => expect(contract.empty.kind).toBe('not-applicable'),
  );

  it.each(Object.keys(contracts) as Route[])('%s inherits rendered loading and error boundaries', async () => {
    const [{default: Loading}, {default: ErrorState}] = await Promise.all([import('@/app/loading'), import('@/app/error')]);
    const loadingHtml = renderToStaticMarkup(createElement(Loading));
    const errorHtml = renderToStaticMarkup(createElement(ErrorState, {error: new Error('route failed'), reset: () => undefined}));
    expect(loadingHtml).toContain('aria-busy="true"');
    expect(errorHtml).toContain('role="alert"');
    expect(errorHtml).toContain('state.retry');
  });

  it('has no serious or critical axe violations across every jsdom-renderable route state and viewport', async () => {
    // axe-core result contract: https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#results-object
    const {default: axe} = await import('axe-core');
    const [{default: Loading}, {default: ErrorState}, {createMockDataSource}] = await Promise.all([
      import('@/app/loading'), import('@/app/error'), import('@/lib/data/mock'),
    ]);
    const failures: string[] = [];
    const exclusions: string[] = [];
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    for (const width of [375, 1280]) {
      Object.defineProperty(window, 'innerWidth', {configurable: true, value: width});
      for (const [route, contract] of Object.entries(contracts) as [Route, RouteContract][]) {
        const source = createMockDataSource();
        const states: Array<[string, string]> = [
          ['filled', await renderRoute(route, source, false)],
          ['loading', renderToStaticMarkup(createElement(Loading))],
          ['error', renderToStaticMarkup(createElement(ErrorState, {error: new Error('route failed'), reset: () => undefined}))],
        ];
        if (contract.empty.kind === 'data') {
          states.push(['empty', await renderRoute(route, contract.empty.configure(createMockDataSource()), true)]);
        } else {
          exclusions.push(`${route}@${width}: empty state is not applicable to this non-collection route`);
        }
        for (const [state, html] of states) {
          document.body.innerHTML = html;
          const result = await axe.run(document.body, {rules: {'color-contrast': {enabled: false}}});
          const serious = result.violations.filter(({impact}) => impact === 'serious' || impact === 'critical');
          if (serious.length) failures.push(`${route}@${width}/${state}: ${serious.map(({id}) => id).join(', ')}`);
        }
      }
    }
    canvasContext.mockRestore();
    console.info(`Accessibility route-state exclusions (${exclusions.length}): ${exclusions.join('; ')}`);
    expect(failures).toEqual([]);
  }, 120_000);
});
