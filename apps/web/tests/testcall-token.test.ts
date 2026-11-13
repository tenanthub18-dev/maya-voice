import {createHmac} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {createMockDataSource} from '@/lib/data/mock';

describe('test-call worker token', () => {
  it('signs the exact short-lived claims consumed by the worker', async () => {
    const {createTestCallToken} = await import('@/lib/testcall/token');
    const token = createTestCallToken({
      agentVersionId: 'agent-version-4',
      restaurantId: 'restaurant-1',
    }, 'shared-secret', () => 1_700_000_000_000);
    const [payload, signature] = token.split('.');

    expect(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))).toEqual({
      exp: 1_700_000_060,
      mode: 'test',
      agent_version_id: 'agent-version-4',
      restaurant_id: 'restaurant-1',
    });
    expect(signature).toBe(createHmac('sha256', 'shared-secret').update(payload).digest('hex'));
  });
});

describe('accepted test-call feedback', () => {
  it('creates a new draft revision through the DataSource', async () => {
    const {acceptPromptProposal} = await import('@/lib/testcall/draft');
    const source = createMockDataSource(() => new Date('2026-10-27T14:00:00.000Z'));
    const agent = await source.getAgent();
    const original = await source.saveAgentDraft(agent.id, {rules: 'Confirm every request.'});

    const revised = await acceptPromptProposal(source, original.id, {
      section: 'rules', before: 'Confirm every request.', after: 'Keep confirmations short.'
    });

    expect(revised.versionNo).toBe(original.versionNo + 1);
    expect(revised.promptSections).toEqual({rules: 'Keep confirmations short.'});
    expect((await source.listAgentVersions()).find((row) => row.id === original.id)?.status).toBe('archived');
  });
});
