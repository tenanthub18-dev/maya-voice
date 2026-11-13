import {describe, expect, it, vi} from 'vitest';

import {beforeSend, redact, safeLogger} from '@/lib/security/redaction';

const hostile = {
  message: 'Call +14165550123 or victim@example.com',
  name: 'Jane Caller',
  nested: {apiKey: 'sk_live_secret-value', token: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature'},
};

describe('structured redaction', () => {
  it('recursively scrubs E.164 numbers, emails, name fields, tokens, and API keys without mutating input', () => {
    const result = redact(hostile);
    expect(JSON.stringify(result)).not.toMatch(/14165550123|victim@example\.com|Jane Caller|sk_live_secret-value|eyJhbGci/u);
    expect(hostile.nested.apiKey).toBe('sk_live_secret-value');
  });

  it('uses the same scrubber for web logs and Sentry events', () => {
    const sink = vi.fn();
    safeLogger(sink).error('hostile', hostile);
    expect(JSON.stringify(sink.mock.calls)).not.toMatch(/14165550123|victim@example\.com|Jane Caller|sk_live_secret-value|eyJhbGci/u);
    expect(JSON.stringify(beforeSend({request: {data: hostile}, extra: hostile}))).not.toMatch(/14165550123|victim@example\.com|Jane Caller|sk_live_secret-value|eyJhbGci/u);
  });
});
