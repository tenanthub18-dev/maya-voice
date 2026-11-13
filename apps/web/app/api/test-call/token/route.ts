import {authorizeRouteHandler} from '@/lib/auth/guards';
import {validateMutationOrigin} from '@/lib/api/request';
import {apiError} from '@/lib/api/errors';
import {getDataSource} from '@/lib/data';
import {createTestCallToken} from '@/lib/testcall/token';
import {getCurrentRestaurant} from '@/lib/restaurant';

export async function POST(request: Request): Promise<Response> {
  const originError = validateMutationOrigin(request);
  if (originError) return originError;
  const authorized = await authorizeRouteHandler('publishAgent');
  if (authorized instanceof Response) return authorized;
  const secret = process.env.TEST_CALL_HMAC_SECRET;
  if (!secret) return apiError('CONFIGURATION_ERROR', 'Test-call authentication is not configured', 503);
  const source = getDataSource();
  const [restaurant, versions] = await Promise.all([getCurrentRestaurant(), source.listAgentVersions()]);
  const draft = versions.filter((version) => version.status === 'draft').sort((left, right) => right.versionNo - left.versionNo)[0];
  if (!draft) return apiError('NO_DRAFT', 'No draft agent version is available', 409);
  return Response.json({token: createTestCallToken({
    agentVersionId: draft.id,
    restaurantId: restaurant.id,
  }, secret)});
}
