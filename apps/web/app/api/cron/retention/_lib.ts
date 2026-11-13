export interface RetentionRepository {
  prepareRetention(now: string): Promise<{recordingPaths: string[]; recordings: number; transcripts: number}>;
  removeRecordings(paths: string[]): Promise<void>;
  completeRetention(input: {now: string; dryRun: boolean; removedRecordingPaths: string[]}): Promise<{recordings: number; transcripts: number}>;
}

export function createRetentionHandler(dependencies: {
  cronSecret: string;
  repository: RetentionRepository;
  now?: () => Date;
}) {
  return async (request: Request): Promise<Response> => {
    if (!dependencies.cronSecret || request.headers.get('authorization') !== `Bearer ${dependencies.cronSecret}`) {
      return Response.json({error: {code: 'UNAUTHORIZED', message: 'Invalid cron credentials'}}, {status: 401});
    }
    const current = (dependencies.now ?? (() => new Date()))().toISOString();
    const dryRun = new URL(request.url).searchParams.get('dryRun') === 'true';
    const candidates = await dependencies.repository.prepareRetention(current);
    const removedRecordingPaths = dryRun ? [] : candidates.recordingPaths;
    if (removedRecordingPaths.length > 0) await dependencies.repository.removeRecordings(removedRecordingPaths);
    const result = await dependencies.repository.completeRetention({now: current, dryRun, removedRecordingPaths});
    return Response.json({dryRun, ...result});
  };
}
