import {NextResponse, type NextRequest} from 'next/server';

import {createAuthProvider} from '@/lib/auth/provider';
import {getRouteAccessDecision} from '@/lib/auth/routes';
import {applySecurityHeaders, contentSecurityPolicy} from '@/lib/security/headers';

function copyAuthState(source: NextResponse, target: NextResponse): NextResponse {
  const serializedCookies = source.headers.getSetCookie();
  if (serializedCookies.length > 0) {
    for (const cookie of serializedCookies) target.headers.append('set-cookie', cookie);
  } else {
    for (const cookie of source.cookies.getAll()) target.cookies.set(cookie);
  }
  for (const name of ['cache-control', 'expires', 'pragma']) {
    const value = source.headers.get(name);
    if (value) target.headers.set(name, value);
  }
  return target;
}

export async function proxy(request: NextRequest) {
  // Next.js reads the nonce from the forwarded CSP/request header and applies it
  // to framework and application scripts. https://nextjs.org/docs/app/guides/content-security-policy
  const nonce = btoa(crypto.randomUUID());
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('Content-Security-Policy', contentSecurityPolicy(nonce));
  requestHeaders.set('X-Nonce', nonce);
  let authResponse = NextResponse.next({request: {headers: requestHeaders}});
  const provider = createAuthProvider({
    cookies: {
      getAll: () => request.cookies.getAll().map(({name, value}) => ({name, value})),
      setAll(values) {
        for (const {name, value} of values) request.cookies.set(name, value);
        authResponse = NextResponse.next({request: {headers: requestHeaders}});
        for (const {name, value, options} of values) authResponse.cookies.set(name, value, options);
      },
    },
  });
  const user = await provider.getUser();
  const decision = getRouteAccessDecision({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    user,
  });

  let response = authResponse;
  if (decision.kind === 'redirect') response = copyAuthState(authResponse, NextResponse.redirect(new URL(decision.location, request.url)));
  if (decision.kind === 'not-found') response = copyAuthState(authResponse, new NextResponse(null, {status: 404}));
  if ((process.env.INTEGRATIONS_MODE ?? 'mock') === 'mock') response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  applySecurityHeaders(response.headers, {
    nonce,
    microphone: request.nextUrl.pathname === '/demo' || (request.nextUrl.pathname === '/agent' && request.nextUrl.searchParams.get('tab') === 'testCall'),
  });
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/_mock).*)'],
};
