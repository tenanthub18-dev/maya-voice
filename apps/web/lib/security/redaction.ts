const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /^(?:name|first_?name|last_?name|full_?name|caller_?name|token|access_?token|refresh_?token|authorization|api_?key|secret|password)$/iu;
const E164 = /\+[1-9]\d{7,14}\b/gu;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu;
const KEY_VALUE = /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9_-]+\b/gu;
const SECRET_ASSIGNMENT = /\b(api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/giu;

function scrubString(value: string): string {
  return value.replace(E164, REDACTED).replace(EMAIL, REDACTED).replace(BEARER, REDACTED)
    .replace(KEY_VALUE, REDACTED).replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
}

export function redact<T>(value: T, key = ''): T {
  if (SENSITIVE_KEY.test(key)) return REDACTED as T;
  if (typeof value === 'string') return scrubString(value) as T;
  if (value instanceof Error) return {...value, name: value.name, message: scrubString(value.message), stack: value.stack ? scrubString(value.stack) : undefined} as T;
  if (Array.isArray(value)) return value.map((item) => redact(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)])) as T;
  }
  return value;
}

type LogSink = (message?: unknown, ...values: unknown[]) => void;

export function safeLogger(sink: LogSink) {
  return {
    error(message?: unknown, ...values: unknown[]) { sink(redact(message), ...values.map((value) => redact(value))); },
    info(message?: unknown, ...values: unknown[]) { sink(redact(message), ...values.map((value) => redact(value))); },
    warn(message?: unknown, ...values: unknown[]) { sink(redact(message), ...values.map((value) => redact(value))); },
  };
}

export function beforeSend<T>(event: T): T {
  return redact(event);
}
