import type {AuthorizedRequest} from '@/lib/api/auth';
import {apiError, internalApiError} from '@/lib/api/errors';

interface RecordingDependencies {
  authorize(): Promise<AuthorizedRequest>;
  signedRecordingUrl(callId: string, organizationId: string, expiresInSeconds: number): Promise<string | null>;
  signedAdminRecordingUrl?(callId: string, expiresInSeconds: number): Promise<
    {kind: 'signed'; url: string} | {kind: 'forbidden'} | {kind: 'not-found'}
  >;
}

export function createRecordingHandler(dependencies: RecordingDependencies) {
  return async (
    _request: Request,
    context: {params: Promise<{id: string}>},
  ): Promise<Response> => {
    const authorized = await dependencies.authorize();
    if (!authorized.ok) return authorized.response;
    try {
      const {id} = await context.params;
      if (authorized.user.role === 'platform-admin') {
        const adminResult = await dependencies.signedAdminRecordingUrl?.(id, 300) ?? {kind: 'forbidden' as const};
        if (adminResult.kind === 'forbidden') return apiError('FORBIDDEN', 'An active support session is required', 403);
        if (adminResult.kind === 'not-found') return apiError('NOT_FOUND', 'Recording not found', 404);
        return Response.redirect(adminResult.url, 302);
      }
      if (!authorized.user.organizationId) return apiError('FORBIDDEN', 'Organization access is required', 403);
      const signedUrl = await dependencies.signedRecordingUrl(id, authorized.user.organizationId, 300);
      if (!signedUrl) return apiError('NOT_FOUND', 'Recording not found', 404);
      return Response.redirect(signedUrl, 302);
    } catch {
      return internalApiError();
    }
  };
}
