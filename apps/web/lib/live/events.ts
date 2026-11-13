export type LiveScope = 'restaurant' | 'calls' | 'bookings' | 'orders' | 'messages' | 'agent' | 'usage';

export type LiveEvent = {
  scope: LiveScope;
  source: 'local' | 'broadcast' | 'realtime';
  at: number;
};

type RouteScopes = {route: string; scopes: readonly LiveScope[]};

export const LIVE_SCOPE_ROUTES: readonly RouteScopes[] = [
  {route: '/', scopes: []},
  {route: '/admin', scopes: ['restaurant', 'usage']},
  {route: '/agent', scopes: ['agent', 'restaurant']},
  {route: '/analytics', scopes: ['calls', 'usage']},
  {route: '/billing/cancel', scopes: ['usage']},
  {route: '/billing/success', scopes: ['usage']},
  {route: '/bookings', scopes: ['bookings']},
  {route: '/calls', scopes: ['calls']},
  {route: '/calls/[id]', scopes: ['calls']},
  {route: '/demo', scopes: []},
  {route: '/home', scopes: ['calls', 'bookings', 'orders', 'messages', 'restaurant', 'usage']},
  {route: '/invite/accept', scopes: []},
  {route: '/login', scopes: []},
  {route: '/onboarding/[step]', scopes: ['restaurant']},
  {route: '/orders', scopes: ['orders']},
  {route: '/phone', scopes: ['restaurant']},
  {route: '/settings', scopes: ['restaurant', 'usage']},
  {route: '/signup', scopes: []},
] as const;

function segmentsMatch(route: string, pathname: string): boolean {
  const routeSegments = route.split('/');
  const pathSegments = pathname.split('/');
  return routeSegments.length === pathSegments.length && routeSegments.every((segment, index) => {
    return /^\[[^\]]+\]$/u.test(segment) || segment === pathSegments[index];
  });
}

function normalizePath(pathname: string): string {
  if (pathname === '/') return pathname;
  return pathname.replace(/\/+$/u, '');
}

export function scopesForPath(pathname: string): readonly LiveScope[] {
  const normalized = normalizePath(pathname);
  return LIVE_SCOPE_ROUTES.find(({route}) => segmentsMatch(route, normalized))?.scopes ?? [];
}

export function hasLiveScopeRoute(route: string): boolean {
  return LIVE_SCOPE_ROUTES.some(({route: registered}) => registered === normalizePath(route));
}
