// @vitest-environment jsdom

import {cleanup, render, screen} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('next/navigation', () => ({usePathname: () => '/home'}));
vi.mock('next/link', () => ({default: ({children, href, ...props}: {children: React.ReactNode; href: string}) => <a href={href} {...props}>{children}</a>}));
vi.mock('next-intl', () => ({useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
  if (namespace === 'screens.admin' && key === 'supportBanner') return `Support view of ${values?.restaurant} — read-only, expires ${values?.expires}`;
  if (namespace === 'screens.admin' && key === 'endSession') return 'End session';
  return `${namespace}.${key}`;
}}));
vi.mock('@/app/admin/actions', () => ({endSupportSession: vi.fn()}));
vi.mock('@/components/live-sync', () => ({LiveSync: () => null, LiveStatus: () => null}));
vi.mock('@/components/locale-switcher', () => ({LocaleSwitcher: () => null}));

import {AppShell} from '@/components/app-shell';

afterEach(cleanup);

describe('support view shell', () => {
  it('shows the required banner and disables restaurant-page controls while leaving End session available', () => {
    const {container} = render(<AppShell demo productName="Maya" restaurantName="Harbour Table" restaurantId="restaurant-1" supportView={{sessionId: 'session-1', restaurantName: 'Harbour Table', expiresLabel: '10/27/26, 12:30 PM'}}><form><button>Mutate restaurant</button></form></AppShell>);

    expect(screen.getByText('Support view of Harbour Table — read-only, expires 10/27/26, 12:30 PM')).not.toBeNull();
    const mutation = screen.getByRole('button', {name: 'Mutate restaurant'});
    expect((mutation.closest('fieldset') as HTMLFieldSetElement | null)?.disabled).toBe(true);
    expect((screen.getByRole('button', {name: 'End session'}) as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('fieldset[disabled]')).not.toBeNull();
  });
});
