import type {AuthUser} from './types';

// Carrier callbacks authenticate inside their handler with Telnyx's signature,
// rather than a browser session: https://developers.telnyx.com/docs/development/api-fundamentals/webhooks/receiving-webhooks
const PUBLIC_EXACT = new Set(['/', '/login', '/signup', '/auth/callback', '/invite/accept', '/api/webhooks/telnyx-sms', '/demo', '/api/demo/session', '/audio/pcm-capture.js']);

export type RouteAccessDecision =
  | {kind: 'allow'}
  | {kind: 'redirect'; location: string}
  | {kind: 'not-found'};

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || pathname.startsWith('/_next/') || pathname === '/favicon.ico';
}

export function getRouteAccessDecision(input: {
  pathname: string;
  search: string;
  user: AuthUser | null;
}): RouteAccessDecision {
  if (isPublicRoute(input.pathname)) return {kind: 'allow'};
  if (!input.user) {
    const returnTo = `${input.pathname}${input.search}`;
    return {kind: 'redirect', location: `/login?returnTo=${encodeURIComponent(returnTo)}`};
  }
  if (input.pathname === '/admin' || input.pathname.startsWith('/admin/')) {
    return input.user.role === 'platform-admin' ? {kind: 'allow'} : {kind: 'not-found'};
  }
  return {kind: 'allow'};
}
