import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {hasLiveScopeRoute, scopesForPath} from '@/lib/live/events';

async function pageRoutes(directory: string, segments: string[] = []): Promise<string[]> {
  const routes: string[] = [];
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) routes.push(...await pageRoutes(path.join(directory, entry.name), [...segments, entry.name]));
    else if (entry.name === 'page.tsx') routes.push(`/${segments.join('/')}`.replace(/\/$/u, '') || '/');
  }
  return routes;
}

describe('live route scopes', () => {
  it('maps the required route scopes', () => {
    expect(scopesForPath('/home')).toEqual(['calls', 'bookings', 'orders', 'messages', 'restaurant', 'usage']);
    expect(scopesForPath('/calls')).toEqual(['calls']);
    expect(scopesForPath('/calls/call-1')).toEqual(['calls']);
    expect(scopesForPath('/bookings')).toEqual(['bookings']);
    expect(scopesForPath('/orders')).toEqual(['orders']);
    expect(scopesForPath('/agent')).toEqual(['agent', 'restaurant']);
    expect(scopesForPath('/settings')).toEqual(['restaurant', 'usage']);
    expect(scopesForPath('/admin')).toEqual(['restaurant', 'usage']);
  });

  it('has a single-table entry for every app page route', async () => {
    const routes = await pageRoutes(path.join(process.cwd(), 'app'));
    expect(routes.filter((route) => !hasLiveScopeRoute(route))).toEqual([]);
  });
});
