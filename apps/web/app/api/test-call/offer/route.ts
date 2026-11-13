import {z} from 'zod';

import {authorizeApiRequest} from '@/lib/api/auth';
import {apiError, internalApiError} from '@/lib/api/errors';
import {parseJsonBody} from '@/lib/api/request';
import {getDataSource} from '@/lib/data';
import {signWorkerRequest} from '@/lib/security/worker-hmac';
import {createTestCallToken} from '@/lib/testcall/token';
import {getCurrentRestaurant} from '@/lib/restaurant';

const offerSchema = z.object({
  sdp: z.string().min(1).max(60_000),
  type: z.literal('offer'),
}).strict();

async function handle(request: Request): Promise<Response> {
  const authorized = await authorizeApiRequest(['owner']);
  if (!authorized.ok) return authorized.response;
  const parsed = await parseJsonBody(request, offerSchema);
  if (!parsed.ok) return parsed.response;
  const workerBaseUrl = process.env.WORKER_BASE_URL;
  const secret = process.env.TEST_CALL_HMAC_SECRET;
  if (!workerBaseUrl || !secret) return apiError('CONFIGURATION_ERROR', 'Test-call authentication is not configured', 503);

  const source = getDataSource();
  const [restaurant, versions] = await Promise.all([getCurrentRestaurant(), source.listAgentVersions()]);
  const draft = versions.filter((version) => version.status === 'draft')
    .sort((left, right) => right.versionNo - left.versionNo)[0];
  if (!draft) return apiError('NO_DRAFT', 'No draft agent version is available', 409);

  const body = JSON.stringify(parsed.data);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = signWorkerRequest({secret, timestamp, method: 'POST', path: '/webrtc/offer', body});
  const token = createTestCallToken({agentVersionId: draft.id, restaurantId: restaurant.id}, secret);
  const response = await fetch(`${workerBaseUrl.replace(/\/+$/u, '')}/webrtc/offer`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-timestamp': signature.timestamp,
        'x-signature': signature.signature,
      },
      body,
      redirect: 'error',
  });
  const responseBody = await response.arrayBuffer();
  return new Response(responseBody, {
    status: response.status,
    headers: {'content-type': response.headers.get('content-type') ?? 'application/json'},
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await handle(request);
  } catch {
    return internalApiError();
  }
}
