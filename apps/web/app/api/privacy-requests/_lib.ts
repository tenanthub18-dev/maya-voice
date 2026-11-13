import {z} from 'zod';

import type {AuthorizedRequest} from '@/lib/api/auth';
import type {PrivacyRequestAction, PrivacyRequestRecord} from '@/lib/api/repository';
import {apiError, internalApiError} from '@/lib/api/errors';
import {parseJsonBody} from '@/lib/api/request';
import {callerReference} from '@/lib/compliance/caller-reference';

const privacyRequestSchema = z.object({
  restaurantId: z.string().uuid(),
  scope: z.enum(['caller', 'restaurant']).default('caller'),
  callerPhone: z.string().regex(/^\+[1-9]\d{7,14}$/u).optional(),
  confirmRestaurantDeletion: z.boolean().optional(),
  requestType: z.enum(['export', 'delete']),
}).strict().superRefine((value, context) => {
  if (value.scope === 'caller' && !value.callerPhone) context.addIssue({code: 'custom', path: ['callerPhone'], message: 'Caller phone is required'});
  if (value.scope === 'restaurant' && value.requestType === 'delete' && value.confirmRestaurantDeletion !== true) {
    context.addIssue({code: 'custom', path: ['confirmRestaurantDeletion'], message: 'Restaurant deletion confirmation is required'});
  }
});

const privacyTransitionSchema = z.object({
  requestId: z.string().uuid(),
  action: z.enum(['verify', 'fulfill', 'reject']),
  reason: z.string().trim().min(1).max(500).optional(),
  verificationMethod: z.enum(['callback', 'account-record', 'written-document']).optional(),
  verificationReference: z.string().trim().min(4).max(100).regex(/^[\p{L}\p{N} ._:/-]+$/u)
    .refine((value) => !/\+[1-9]\d{7,14}/u.test(value), 'Do not store a phone number as verification evidence').optional(),
  restaurantId: z.string().uuid().optional(),
  callerPhone: z.string().regex(/^\+[1-9]\d{7,14}$/u).optional(),
}).strict().refine((value) => value.action !== 'reject' || value.reason !== undefined, {
  message: 'A rejection reason is required', path: ['reason'],
}).refine((value) => value.action !== 'verify' || (value.verificationMethod !== undefined && value.verificationReference !== undefined), {
  message: 'Verification evidence is required', path: ['verificationReference'],
}).refine((value) => value.action !== 'fulfill' || (value.restaurantId !== undefined && value.callerPhone !== undefined), {
  message: 'Caller reference is required for fulfillment', path: ['callerPhone'],
});

interface PrivacyRequestRepository {
  findRestaurantOrganizationId(restaurantId: string): Promise<string | null>;
  createPrivacyRequest(input: {
    actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
    callerHash: string; callerLast4: string;
  }): Promise<PrivacyRequestRecord>;
  transitionPrivacyRequest(input: {
    actorId: string; organizationId: string; requestId: string; action: PrivacyRequestAction; reason?: string;
    verificationMethod?: 'callback' | 'account-record' | 'written-document'; verificationReference?: string;
    restaurantId?: string; callerPhone?: string; callerHash?: string;
  }): Promise<PrivacyRequestRecord>;
  listPrivacyRequests(actorId: string, organizationId: string): Promise<PrivacyRequestRecord[]>;
  purgeExpiredPrivacyResults(): Promise<number>;
  executeRestaurantPrivacyRequest(input: {
    actorId: string; organizationId: string; restaurantId: string; requestType: 'export' | 'delete';
  }): Promise<PrivacyRequestRecord>;
}

interface PrivacyRequestDependencies {
  authorize(): Promise<AuthorizedRequest>;
  repository: PrivacyRequestRepository;
  hashSecret: string;
}

export function createPrivacyRequestHandler(dependencies: PrivacyRequestDependencies) {
  return async (request: Request): Promise<Response> => {
    const authorized = await dependencies.authorize();
    if (!authorized.ok) return authorized.response;
    if (!authorized.user.organizationId) return apiError('FORBIDDEN', 'Organization access is required', 403);

    if (request.method === 'GET') {
      if (authorized.user.role !== 'owner') return apiError('FORBIDDEN', 'Owner access is required', 403);
      try {
        await dependencies.repository.purgeExpiredPrivacyResults();
        return Response.json({requests: await dependencies.repository.listPrivacyRequests(authorized.user.id, authorized.user.organizationId)});
      } catch { return internalApiError(); }
    }

    if (request.method === 'PATCH') {
      if (authorized.user.role !== 'owner') return apiError('FORBIDDEN', 'Owner access is required', 403);
      const parsed = await parseJsonBody(request, privacyTransitionSchema);
      if (!parsed.ok) return parsed.response;
      try {
        const callerHash = parsed.data.action === 'fulfill'
          ? callerReference(dependencies.hashSecret, parsed.data.restaurantId!, parsed.data.callerPhone!)
          : undefined;
        const record = await dependencies.repository.transitionPrivacyRequest({
          actorId: authorized.user.id,
          organizationId: authorized.user.organizationId,
          ...parsed.data,
          ...(callerHash ? {callerHash} : {}),
        });
        return Response.json(record);
      } catch (cause) {
        if (cause instanceof Error && cause.message.includes('PRIVACY_REQUEST_NOT_VERIFIED')) {
          return apiError('CONFLICT', 'Verify the caller identity before fulfillment', 409);
        }
        if (cause instanceof Error && cause.message.includes('PRIVACY_REQUEST_RECORDINGS_PENDING')) {
          return apiError('CONFLICT', 'Recording cleanup changed; retry fulfillment', 409);
        }
        if (cause instanceof Error && cause.message.includes('PRIVACY_REQUEST_NOT_FOUND')) {
          return apiError('NOT_FOUND', 'Privacy request not found', 404);
        }
        return internalApiError();
      }
    }

    const parsed = await parseJsonBody(request, privacyRequestSchema);
    if (!parsed.ok) return parsed.response;

    try {
      const ownerOrganizationId = await dependencies.repository
        .findRestaurantOrganizationId(parsed.data.restaurantId);
      if (ownerOrganizationId !== authorized.user.organizationId) {
        return apiError('NOT_FOUND', 'Restaurant not found', 404);
      }
      if (parsed.data.scope === 'restaurant') {
        if (authorized.user.role !== 'owner') return apiError('FORBIDDEN', 'Owner access is required', 403);
        const record = await dependencies.repository.executeRestaurantPrivacyRequest({
          actorId: authorized.user.id,
          organizationId: authorized.user.organizationId,
          restaurantId: parsed.data.restaurantId,
          requestType: parsed.data.requestType,
        });
        return Response.json(record);
      }
      const callerPhone = parsed.data.callerPhone!;
      const callerHash = callerReference(dependencies.hashSecret, parsed.data.restaurantId, callerPhone);
      const record = await dependencies.repository.createPrivacyRequest({
        actorId: authorized.user.id,
        organizationId: authorized.user.organizationId,
        restaurantId: parsed.data.restaurantId,
        requestType: parsed.data.requestType,
        callerHash,
        callerLast4: callerPhone.slice(-4),
      });
      return Response.json(record, {status: 202});
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('PRIVACY_REQUEST_RATE_LIMITED')) {
        return apiError('RATE_LIMITED', 'Too many privacy requests', 429);
      }
      return internalApiError();
    }
  };
}
