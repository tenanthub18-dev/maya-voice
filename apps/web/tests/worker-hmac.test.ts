import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';

import {signWorkerRequest, verifyWorkerRequest} from '@/lib/security/worker-hmac';

const fixture = JSON.parse(readFileSync(
  path.resolve(process.cwd(), '../../packages/shared/fixtures/worker-hmac.json'),
  'utf8',
)) as Record<string, string>;

describe('worker request HMAC', () => {
  it('matches the cross-language fixture exactly', () => {
    expect(signWorkerRequest({
      secret: fixture.secret_utf8,
      timestamp: fixture.timestamp,
      method: fixture.method,
      path: fixture.path,
      body: fixture.body_utf8,
    })).toEqual({
      timestamp: fixture.timestamp,
      signature: `sha256=${fixture.signature_hex}`,
    });
  });

  it('accepts the five-minute boundary and rejects replay outside it or tampering', () => {
    const input = {
      secret: fixture.secret_utf8,
      timestamp: fixture.timestamp,
      signature: `sha256=${fixture.signature_hex}`,
      method: fixture.method,
      path: fixture.path,
      body: fixture.body_utf8,
    };
    expect(verifyWorkerRequest(input, 1_700_000_300)).toBe(true);
    expect(verifyWorkerRequest(input, 1_700_000_301)).toBe(false);
    expect(verifyWorkerRequest({...input, body: `${fixture.body_utf8} `}, 1_700_000_000)).toBe(false);
    expect(verifyWorkerRequest({...input, path: '/internal/publish'}, 1_700_000_000)).toBe(false);
  });
});
