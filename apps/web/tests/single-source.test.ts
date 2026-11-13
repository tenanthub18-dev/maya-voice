// @vitest-environment jsdom

import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';

import {cleanup, render, screen} from '@testing-library/react';
import {createElement, type ComponentType, type ReactElement, type ReactNode} from 'react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import messages from '@/messages/en.json';

const productName = 'Central Brand Test';
const brandModule = '@/lib/brand';
const restaurantModule = '@/lib/restaurant';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(),
  usePathname: () => '/home',
}));
vi.mock('next-intl/server', () => ({
  getFormatter: async () => ({number: (value: number) => String(value), dateTime: (value: Date) => value.toISOString()}),
  getLocale: async () => 'en',
  getMessages: async () => ({}),
  getTranslations: async (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    namespace === 'screens.home' && key === 'title' ? `Today at ${String(values?.restaurant)}` : `${namespace}.${key}`,
}));
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(process.cwd(), absolute);
    if (entry.isDirectory()) {
      if (!['tests', 'e2e'].includes(entry.name)) files.push(...await sourceFiles(absolute));
    } else if (relative !== path.join('lib', 'brand.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | undefined {
  if (!node || typeof node !== 'object' || !('props' in node)) return undefined;
  const element = node as ReactElement<{children?: ReactNode}>;
  if (predicate(element)) return element;
  const children = element.props.children;
  const values = Array.isArray(children) ? children : [children];
  for (const child of values) {
    const match = findElement(child, predicate);
    if (match) return match;
  }
  return undefined;
}

function localized(children: ReactNode): ReactElement {
  const Provider = NextIntlClientProvider as ComponentType<{locale: string; messages: typeof messages; children?: ReactNode}>;
  return createElement(Provider, {locale: 'en', messages}, children);
}

function mockFonts(): void {
  vi.doMock('next/font/google', () => ({
    Inter: () => ({variable: ''}),
    Noto_Nastaliq_Urdu: () => ({variable: ''}),
    Noto_Sans_Devanagari: () => ({variable: ''}),
    Noto_Sans_Gurmukhi: () => ({variable: ''}),
  }));
  vi.doMock('next/font/local', () => ({default: () => ({variable: ''})}));
}

beforeEach(() => {
  vi.resetModules();
  process.env.DATA_SOURCE = 'mock';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/brand');
  vi.doUnmock('@/lib/auth/guards');
  vi.doUnmock('@/lib/auth/server');
  vi.doUnmock('next/font/google');
  vi.doUnmock('next/font/local');
});

describe('product identity source', () => {
  it('keeps every product-name literal in lib/brand.ts only', async () => {
    const roots = ['app', 'components', 'lib', 'messages'].map((directory) => path.join(process.cwd(), directory));
    const failures: string[] = [];
    for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
      const contents = await readFile(file, 'utf8');
      for (const literal of ['Hostline', 'Maya Reception', 'Réception Maya', 'Maya']) {
        if (contents.includes(literal)) failures.push(`${path.relative(process.cwd(), file)} contains ${literal}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps the product name separate from the default persona name', async () => {
    const {BRAND, getProductName} = await import(brandModule);
    expect(getProductName('en')).not.toBe(BRAND.defaultPersonaName);
  });

  it('passes a changed central brand through the landing and shell server parents', async () => {
    vi.doMock('@/lib/brand', () => ({
      BRAND: Object.freeze({product: Object.freeze({en: productName, fr: 'Marque test', 'fr-CA': 'Marque test'}), defaultPersonaName: 'Persona Test'}),
      getProductName: () => productName,
    }));
    vi.doMock('@/lib/auth/server', () => ({createServerAuthProvider: async () => ({getUser: async () => null})}));
    mockFonts();
    const [{default: IndexPage}, {default: RootLayout}] = await Promise.all([
      import('@/app/page'),
      import('@/app/layout'),
    ]);
    render(localized(await IndexPage()));
    expect(screen.getByText(productName)).toBeTruthy();
    expect(screen.getByText(/Persona Test books tables/u)).toBeTruthy();
    cleanup();

    const layout = await RootLayout({children: createElement('div', undefined, 'Page body')});
    const shell = findElement(layout, (element) => typeof element.type === 'function' && element.type.name === 'AppShell');
    expect(shell?.props).toMatchObject({productName});
  });
});

describe('restaurant identity source', () => {
  it.each([
    ['anonymous user', null],
    ['tenantless owner', {id: 'owner-new', email: 'new@example.com', role: 'owner', organizationId: null}],
    ['platform admin', {id: 'admin-1', email: 'admin@example.com', role: 'platform-admin', organizationId: null}],
  ])('does not read tenant data for an %s', async (_label, user) => {
    const {getDataSource} = await import('@/lib/data');
    const getRestaurant = vi.spyOn(getDataSource(), 'getRestaurant').mockRejectedValue(new Error('RLS denied'));
    vi.doMock('@/lib/auth/server', () => ({createServerAuthProvider: async () => ({getUser: async () => user})}));
    mockFonts();
    const {default: RootLayout} = await import('@/app/layout');

    await expect(RootLayout({children: createElement('div', undefined, 'Public page')})).resolves.toBeTruthy();
    expect(getRestaurant).not.toHaveBeenCalled();
  });

  it('propagates a rename to the cached read, dashboard, admin row, and mock digest recipient', async () => {
    vi.doMock('@/lib/auth/guards', () => ({requireCapability: vi.fn().mockResolvedValue(undefined)}));
    const [{getDataSource}, {getCurrentRestaurant}, {HomeScreen}, {default: AdminPage}, {createMockDigestRepository}] = await Promise.all([
      import('@/lib/data'),
      import(restaurantModule),
      import('@/components/dashboard-screen'),
      import('@/app/admin/page'),
      import('@/app/api/cron/digest/_lib'),
    ]);
    const source = getDataSource();
    const before = await source.getRestaurant();
    await source.updateRestaurantBasics({name: 'Renamed Cafe', address: before.address});

    expect((await getCurrentRestaurant()).name).toBe('Renamed Cafe');
    render(localized(await HomeScreen()));
    expect(screen.getByRole('heading', {name: /Renamed Cafe/u})).toBeTruthy();
    cleanup();

    render(localized(await AdminPage({searchParams: Promise.resolve({})})));
    expect(screen.getAllByText('Renamed Cafe').length).toBeGreaterThan(0);
    cleanup();

    const recipients = await createMockDigestRepository().listDailyDigestRecipients();
    expect(recipients[0]?.restaurantName).toBe('Renamed Cafe');
  });

  it('does not hard-code the mock restaurant name in app or component source', async () => {
    const roots = ['app', 'components'].map((directory) => path.join(process.cwd(), directory));
    const failures: string[] = [];
    for (const file of (await Promise.all(roots.map(sourceFiles))).flat()) {
      if ((await readFile(file, 'utf8')).includes('Harbour Table')) failures.push(path.relative(process.cwd(), file));
    }
    expect(failures).toEqual([]);
  });
});
