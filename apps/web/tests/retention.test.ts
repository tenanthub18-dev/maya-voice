import {describe, expect, it, vi} from 'vitest';

import {createRetentionHandler} from '@/app/api/cron/retention/_lib';

const now = new Date('2026-10-27T04:00:00.000Z');

function dependencies() {
  return {
    cronSecret: 'cron-secret',
    now: () => now,
    repository: {
      prepareRetention: vi.fn(async () => ({
        recordingPaths: ['restaurant/call.mp3'], recordings: 1, transcripts: 2,
      })),
      removeRecordings: vi.fn(async () => undefined),
      completeRetention: vi.fn(async () => ({recordings: 1, transcripts: 2})),
    },
  };
}

describe('retention cron', () => {
  it('rejects requests without the configured bearer secret before repository access', async () => {
    const deps = dependencies();
    const response = await createRetentionHandler(deps)(new Request('https://app.example/api/cron/retention'));
    expect(response.status).toBe(401);
    expect(deps.repository.prepareRetention).not.toHaveBeenCalled();
  });

  it('uses the injected clock, removes storage objects, finalizes SQL, and reports counts', async () => {
    const deps = dependencies();
    const response = await createRetentionHandler(deps)(new Request('https://app.example/api/cron/retention', {
      headers: {authorization: 'Bearer cron-secret'},
    }));
    expect(response.status).toBe(200);
    expect(deps.repository.prepareRetention).toHaveBeenCalledWith(now.toISOString());
    expect(deps.repository.removeRecordings).toHaveBeenCalledWith(['restaurant/call.mp3']);
    expect(deps.repository.completeRetention).toHaveBeenCalledWith({
      now: now.toISOString(), dryRun: false, removedRecordingPaths: ['restaurant/call.mp3'],
    });
    await expect(response.json()).resolves.toEqual({dryRun: false, recordings: 1, transcripts: 2});
  });

  it('dry-runs without deleting storage while still asking SQL to audit the run', async () => {
    const deps = dependencies();
    const response = await createRetentionHandler(deps)(new Request('https://app.example/api/cron/retention?dryRun=true', {
      headers: {authorization: 'Bearer cron-secret'},
    }));
    expect(response.status).toBe(200);
    expect(deps.repository.removeRecordings).not.toHaveBeenCalled();
    expect(deps.repository.completeRetention).toHaveBeenCalledWith({
      now: now.toISOString(), dryRun: true, removedRecordingPaths: [],
    });
  });
});
