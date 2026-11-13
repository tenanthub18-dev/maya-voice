const AUTH_PATHS = new Set(['/login', '/signup', '/auth/callback']);

function safelyDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function sanitizeReturnTo(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/home';
  }
  const decoded = safelyDecode(value);
  if (
    !decoded || decoded.startsWith('//') || decoded.includes('\\')
    || /[\u0000-\u001f\u007f]/u.test(decoded)
    || /[\u2044\u2215\u29f8\uff0f]/u.test(decoded)
  ) return '/home';
  let parsed: URL;
  try {
    parsed = new URL(decoded, 'https://app.invalid');
  } catch {
    return '/home';
  }
  if (parsed.origin !== 'https://app.invalid' || AUTH_PATHS.has(parsed.pathname)) return '/home';
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
