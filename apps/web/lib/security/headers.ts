const HSTS = 'max-age=63072000; includeSubDomains; preload';

export const STATIC_SECURITY_HEADERS = [
  {key: 'Strict-Transport-Security', value: HSTS},
  {key: 'X-Content-Type-Options', value: 'nosniff'},
  {key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin'},
  {key: 'Cross-Origin-Opener-Policy', value: 'same-origin'},
  {key: 'Cross-Origin-Resource-Policy', value: 'same-origin'},
] as const;

function origin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

function websocketOrigin(value: string | undefined): string | undefined {
  const parsed = origin(value);
  if (!parsed) return undefined;
  return parsed.replace(/^https:/u, 'wss:').replace(/^http:/u, 'ws:');
}

export function contentSecurityPolicy(nonce: string, env: NodeJS.ProcessEnv = process.env): string {
  const connectOrigins = new Set<string>(["'self'"]);
  const mediaOrigins = new Set<string>(["'self'", 'blob:']);
  const workerWsOrigin = websocketOrigin(env.WORKER_BASE_URL);
  if (workerWsOrigin) connectOrigins.add(workerWsOrigin);
  for (const value of [env.NEXT_PUBLIC_SUPABASE_URL]) {
    const httpOrigin = origin(value);
    const wsOrigin = websocketOrigin(value);
    if (httpOrigin) connectOrigins.add(httpOrigin);
    if (wsOrigin) connectOrigins.add(wsOrigin);
    if (httpOrigin) mediaOrigins.add(httpOrigin);
  }
  const directives = [
    "default-src 'self'",
    // React's development debugger requires eval; production never permits it.
    // https://nextjs.org/docs/app/guides/content-security-policy
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${[...connectOrigins].join(' ')}`,
    `media-src ${[...mediaOrigins].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ];
  return directives.join('; ');
}

export function applySecurityHeaders(
  headers: Headers,
  input: {nonce: string; microphone: boolean; env?: NodeJS.ProcessEnv},
): void {
  headers.set('Content-Security-Policy', contentSecurityPolicy(input.nonce, input.env));
  for (const {key, value} of STATIC_SECURITY_HEADERS) headers.set(key, value);
  headers.set(
    'Permissions-Policy',
    `camera=(), geolocation=(), payment=(), usb=(), microphone=${input.microphone ? '(self)' : '()'}`,
  );
  headers.set('X-Nonce', input.nonce);
}
