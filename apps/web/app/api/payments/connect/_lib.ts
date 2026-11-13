import type {AuthorizedRequest} from '@/lib/api/auth';
import {apiError, internalApiError} from '@/lib/api/errors';
import {validateMutationOrigin} from '@/lib/api/request';

interface PaymentConnectionRepository {
  getRestaurantPaymentConnection(organizationId: string): Promise<{
    restaurantId: string;
    connectedAccountId: string | null;
  } | null>;
  setRestaurantConnectedAccount(restaurantId: string, accountId: string | null): Promise<void>;
}

interface ConnectStripeGateway {
  createStandardAccount(input: {restaurantId: string}, options: {idempotencyKey: string}): Promise<{id: string}>;
  createAccountOnboardingLink(input: {
    accountId: string;
    refreshUrl: string;
    returnUrl: string;
  }, options: {idempotencyKey: string}): Promise<{url: string}>;
  retrieveAccount(input: {accountId: string}): Promise<{
    charges_enabled: boolean;
    details_submitted: boolean;
    payouts_enabled: boolean;
  }>;
}

export interface PaymentConnectDependencies {
  authorize(): Promise<AuthorizedRequest>;
  isEnabled(restaurantId: string): Promise<boolean>;
  repository: PaymentConnectionRepository;
  stripe: ConnectStripeGateway;
  appUrl: string;
  nowSeconds?: () => number;
}

type Handler = (request: Request) => Promise<Response>;

async function connection(deps: PaymentConnectDependencies): Promise<
  | {restaurantId: string; connectedAccountId: string | null}
  | Response
> {
  const authorization = await deps.authorize();
  if (!authorization.ok) return authorization.response;
  const organizationId = authorization.user.organizationId;
  if (!organizationId) return apiError('FORBIDDEN', 'Organization membership is required', 403);
  const record = await deps.repository.getRestaurantPaymentConnection(organizationId);
  if (!record) return apiError('NOT_FOUND', 'Restaurant was not found', 404);
  if (!await deps.isEnabled(record.restaurantId)) {
    return apiError('feature_disabled', 'Diner payments are disabled', 403);
  }
  return record;
}

function wrap(operation: Handler): Handler {
  return async (request) => {
    try {
      return await operation(request);
    } catch {
      return internalApiError();
    }
  };
}

export function createPaymentConnectHandler(deps: PaymentConnectDependencies): Record<'GET' | 'POST' | 'DELETE', Handler> {
  return {
    GET: wrap(async () => {
      const record = await connection(deps);
      if (record instanceof Response) return record;
      if (!record.connectedAccountId) return Response.json({status: 'not_connected'});
      const account = await deps.stripe.retrieveAccount({accountId: record.connectedAccountId});
      const ready = account.charges_enabled && account.details_submitted && account.payouts_enabled;
      return Response.json({status: ready ? 'ready' : 'pending', connectedAccountId: record.connectedAccountId});
    }),
    POST: wrap(async (request) => {
      const originError = validateMutationOrigin(request);
      if (originError) return originError;
      const record = await connection(deps);
      if (record instanceof Response) return record;
      let accountId = record.connectedAccountId;
      if (!accountId) {
        const account = await deps.stripe.createStandardAccount(
          {restaurantId: record.restaurantId},
          {idempotencyKey: `connect-account:${record.restaurantId}`},
        );
        accountId = account.id;
        await deps.repository.setRestaurantConnectedAccount(record.restaurantId, accountId);
      }
      const link = await deps.stripe.createAccountOnboardingLink({
        accountId,
        refreshUrl: `${deps.appUrl}/settings?connect=refresh`,
        returnUrl: `${deps.appUrl}/settings?connect=return`,
      }, {idempotencyKey: `connect-link:${record.restaurantId}:${accountId}:${deps.nowSeconds?.() ?? Math.floor(Date.now() / 1_000)}`});
      return Response.json({status: 'pending', url: link.url});
    }),
    DELETE: wrap(async (request) => {
      const originError = validateMutationOrigin(request);
      if (originError) return originError;
      const record = await connection(deps);
      if (record instanceof Response) return record;
      await deps.repository.setRestaurantConnectedAccount(record.restaurantId, null);
      return Response.json({status: 'not_connected'});
    }),
  };
}
