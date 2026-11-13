import {z} from 'zod';

import type {AuthorizedRequest} from '@/lib/api/auth';
import {apiError, internalApiError} from '@/lib/api/errors';
import {rateLimitedResponse, type PersistentRateLimiter} from '@/lib/api/rate-limit';
import {parseJsonBody} from '@/lib/api/request';
import type {ManagedPhoneNumber} from '@/lib/api/repository';
import {ApiError} from '@/lib/integrations/http';

const uuid = z.string().uuid();
const restaurantSchema = z.object({restaurantId: uuid});
const searchSchema = restaurantSchema.extend({
  areaCode: z.string().regex(/^\d{3}$/u),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const buySchema = restaurantSchema.extend({
  phoneNumber: z.string().regex(/^\+[1-9]\d{7,14}$/u),
  customerReference: z.string().trim().min(1).max(100).optional(),
}).strict();
const releaseSchema = z.object({
  phoneNumberId: uuid,
  reason: z.string().trim().min(1).max(500),
}).strict();
const assignSchema = z.object({phoneNumberId: uuid}).strict();

interface ProviderPhone {
  id: string;
  phone_number: string;
  status: string;
}

interface NumberRepository {
  findRestaurantOrganizationId(restaurantId: string): Promise<string | null>;
  getPhoneNumber(id: string): Promise<ManagedPhoneNumber | null>;
  savePhoneNumber(value: Record<string, unknown>): Promise<string>;
  updatePhoneNumber(id: string, value: Record<string, unknown>): Promise<void>;
  finalizePhoneRelease(input: {phoneId: string; actorId: string; target: string; reason: string}): Promise<void>;
  writeAudit(input: {actorId: string; action: string; target: string; reason: string}): Promise<void>;
}

interface TelnyxNumbersGateway {
  searchNumbers(input: {areaCode: string; countryCode?: string; limit?: number}): Promise<unknown>;
  orderNumber(input: {phoneNumber: string; customerReference?: string; messagingProfileId?: string}): Promise<{
    data: {id: string; record_type: string; status: string; phone_numbers: ProviderPhone[]};
  }>;
  releaseNumber(id: string): Promise<unknown>;
  assignToTeXmlApp(id: string, connectionId: string): Promise<unknown>;
}

export interface NumberRoutesDependencies {
  authorize(): Promise<AuthorizedRequest>;
  consumeRateLimit(request: Request, userId: string): Response | null;
  purchaseLimiter: PersistentRateLimiter;
  repository: NumberRepository;
  telnyx: TelnyxNumbersGateway;
  texmlAppId: string;
  messagingProfileId: string;
}

type Handler = (request: Request) => Promise<Response>;

class ProviderRouteError extends Error {}

async function providerCall<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new ProviderRouteError('Telnyx request failed', {cause: error});
  }
}

async function ownerContext(request: Request, deps: NumberRoutesDependencies) {
  const authorization = await deps.authorize();
  if (!authorization.ok) return authorization.response;
  return deps.consumeRateLimit(request, authorization.user.id) ?? authorization.user;
}

function isResponse(value: Response | {id: string; organizationId: string | null}): value is Response {
  return value instanceof Response;
}

async function ensureRestaurantOwnership(
  restaurantId: string,
  organizationId: string | null,
  repository: NumberRepository,
): Promise<Response | null> {
  const ownerOrganizationId = await repository.findRestaurantOrganizationId(restaurantId);
  if (organizationId === null || ownerOrganizationId !== organizationId) {
    return apiError('FORBIDDEN', 'Restaurant is not owned by this organization', 403);
  }
  return null;
}

async function ownedPhone(
  phoneNumberId: string,
  organizationId: string | null,
  repository: NumberRepository,
): Promise<ManagedPhoneNumber | Response> {
  const phone = await repository.getPhoneNumber(phoneNumberId);
  if (!phone) return apiError('NOT_FOUND', 'Phone number was not found', 404);
  const ownershipError = await ensureRestaurantOwnership(
    phone.restaurantId,
    organizationId,
    repository,
  );
  return ownershipError ?? phone;
}

function route(operation: Handler): Handler {
  return async (request) => {
    try {
      return await operation(request);
    } catch (error) {
      if (error instanceof ProviderRouteError) {
        return apiError('PROVIDER_ERROR', 'Telnyx request failed', 502);
      }
      return internalApiError();
    }
  };
}

export function createSearchNumbersHandler(deps: NumberRoutesDependencies): Handler {
  return route(async (request) => {
    const context = await ownerContext(request, deps);
    if (isResponse(context)) return context;
    const body = await parseJsonBody(request, searchSchema);
    if (!body.ok) return body.response;
    const ownershipError = await ensureRestaurantOwnership(
      body.data.restaurantId,
      context.organizationId,
      deps.repository,
    );
    if (ownershipError) return ownershipError;
    const result = await providerCall(() => deps.telnyx.searchNumbers({
      areaCode: body.data.areaCode,
      countryCode: 'CA',
      ...(body.data.limit === undefined ? {} : {limit: body.data.limit}),
    }));
    return Response.json(result);
  });
}

export function createBuyNumberHandler(deps: NumberRoutesDependencies): Handler {
  return route(async (request) => {
    const context = await ownerContext(request, deps);
    if (isResponse(context)) return context;
    const body = await parseJsonBody(request, buySchema);
    if (!body.ok) return body.response;
    const ownershipError = await ensureRestaurantOwnership(
      body.data.restaurantId,
      context.organizationId,
      deps.repository,
    );
    if (ownershipError) return ownershipError;
    if (!context.organizationId) return apiError('FORBIDDEN', 'Organization access is required', 403);
    const purchaseLimit = await deps.purchaseLimiter.consume({
      scope: 'number-purchase',
      key: context.organizationId,
      limit: 5,
      windowSeconds: 86_400,
    });
    if (!purchaseLimit.allowed) return rateLimitedResponse(purchaseLimit.retryAfterSeconds);

    // Number orders have no documented idempotency support, so the client intentionally
    // does not retry this mutation. https://developers.telnyx.com/api-reference/phone-number-orders/create-a-number-order
    const order = await providerCall(() => deps.telnyx.orderNumber({
      phoneNumber: body.data.phoneNumber,
      customerReference: body.data.customerReference ?? body.data.restaurantId,
      messagingProfileId: deps.messagingProfileId,
    }));
    const phone = order.data.phone_numbers[0];
    if (!phone) throw new ProviderRouteError('Telnyx order contained no phone number');
    const phoneNumberId = await deps.repository.savePhoneNumber({
      restaurant_id: body.data.restaurantId,
      e164: phone.phone_number,
      telnyx_number_id: phone.id,
      status: phone.status === 'active' ? 'active' : 'pending',
    });
    await deps.repository.writeAudit({
      actorId: context.id,
      action: 'phone_number.buy',
      target: phone.id,
      reason: 'Telnyx number purchase',
    });
    return Response.json({...order, phoneNumberId}, {status: 201});
  });
}

export function createReleaseNumberHandler(deps: NumberRoutesDependencies): Handler {
  return route(async (request) => {
    const context = await ownerContext(request, deps);
    if (isResponse(context)) return context;
    const body = await parseJsonBody(request, releaseSchema);
    if (!body.ok) return body.response;
    const phone = await ownedPhone(body.data.phoneNumberId, context.organizationId, deps.repository);
    if (phone instanceof Response) return phone;
    if (phone.status === 'released') {
      return Response.json({data: {
        id: phone.telnyxNumberId,
        record_type: 'phone_number',
        phone_number: phone.e164,
        status: 'deleted',
      }});
    }

    // https://developers.telnyx.com/api-reference/phone-number-configurations/delete-a-phone-number
    if (phone.status !== 'releasing') {
      await deps.repository.updatePhoneNumber(phone.id, {status: 'releasing'});
    }
    let result: unknown;
    try {
      result = await deps.telnyx.releaseNumber(phone.telnyxNumberId);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        result = {data: {id: phone.telnyxNumberId, record_type: 'phone_number', phone_number: phone.e164, status: 'deleted'}};
      } else {
        throw new ProviderRouteError('Telnyx request failed', {cause: error});
      }
    }
    await deps.repository.finalizePhoneRelease({
      phoneId: phone.id,
      actorId: context.id,
      target: phone.telnyxNumberId,
      reason: body.data.reason,
    });
    return Response.json(result);
  });
}

export function createAssignNumberHandler(deps: NumberRoutesDependencies): Handler {
  return route(async (request) => {
    const context = await ownerContext(request, deps);
    if (isResponse(context)) return context;
    const body = await parseJsonBody(request, assignSchema);
    if (!body.ok) return body.response;
    const phone = await ownedPhone(body.data.phoneNumberId, context.organizationId, deps.repository);
    if (phone instanceof Response) return phone;
    if (!deps.texmlAppId) return apiError('CONFIGURATION_ERROR', 'Telnyx TeXML app is not configured', 503);

    // VERIFY live: Telnyx does not explicitly state a TeXML application id is accepted
    // as connection_id. https://developers.telnyx.com/api-reference/phone-number-configurations/update-a-phone-number
    const result = await providerCall(() =>
      deps.telnyx.assignToTeXmlApp(phone.telnyxNumberId, deps.texmlAppId));
    await deps.repository.updatePhoneNumber(phone.id, {status: 'active'});
    return Response.json(result);
  });
}

export function createVerifyForwardingHandler(deps: NumberRoutesDependencies): Handler {
  return route(async (request) => {
    const context = await ownerContext(request, deps);
    if (isResponse(context)) return context;
    const body = await parseJsonBody(request, assignSchema);
    if (!body.ok) return body.response;
    const phone = await ownedPhone(body.data.phoneNumberId, context.organizationId, deps.repository);
    if (phone instanceof Response) return phone;
    return Response.json({
      verified: typeof phone.forwardingVerifiedAt === 'string',
      verifiedAt: phone.forwardingVerifiedAt ?? null,
    });
  });
}
