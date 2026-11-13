import {authorizeApiRequest} from '@/lib/api/auth';
import {createApiRepository} from '@/lib/api/supabase';
import {createServerSupabaseClient} from '@/lib/data/supabase/server';

import {createRecordingHandler} from './_lib';

export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
): Promise<Response> {
  const repository = createApiRepository();
  return createRecordingHandler({
    authorize: () => authorizeApiRequest(['owner', 'staff', 'platform-admin']),
    signedRecordingUrl: (callId, organizationId, expiresInSeconds) =>
      repository.signedRecordingUrl(callId, organizationId, expiresInSeconds),
    async signedAdminRecordingUrl(callId, expiresInSeconds) {
      const client = await createServerSupabaseClient();
      const lookup = await client.rpc('get_admin_recording_path', {p_call_id: callId});
      if (lookup.error) {
        if (lookup.error.code === '42501' || lookup.error.message.includes('SUPPORT_SESSION_REQUIRED')) return {kind: 'forbidden'};
        if (lookup.error.code === 'P0002' || lookup.error.message.includes('RECORDING_NOT_FOUND')) return {kind: 'not-found'};
        throw new Error(lookup.error.message);
      }
      if (typeof lookup.data !== 'string') return {kind: 'not-found'};
      const url = await repository.signedRecordingPath(lookup.data, expiresInSeconds);
      return url ? {kind: 'signed', url} : {kind: 'not-found'};
    },
  })(request, context);
}
