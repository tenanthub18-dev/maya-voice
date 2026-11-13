import {z} from 'zod';

import type {AuthorizedRequest} from '@/lib/api/auth';
import {apiError, internalApiError} from '@/lib/api/errors';
import {parseJsonBody} from '@/lib/api/request';

const checkoutSchema = z.object({plan: z.enum(['starter', 'growth'])}).strict();

interface BillingRepository {
  getOrganizationBilling(id: string): Promise<{id: string; name: string; stripeCustomerId: string | null} | null>;
  getRestaurantIdForOrganization(id: string): Promise<string | null>;
  setOrganizationStripeCustomerId(id: string, customerId: string): Promise<void>;
}

interface BillingStripeGateway {
  createCustomer(input: {name: string; email?: string; restaurantId?: string}, options: {idempotencyKey: string}): Promise<{id: string}>;
  createCheckoutSession(input: {
    customerId: string; basePriceId: string; meteredPriceId: string;
    successUrl: string; cancelUrl: string; restaurantId: string;
  }, options: {idempotencyKey: string}): Promise<{url: string | null}>;
  createPortalSession(input: {customerId: string; returnUrl: string}, options: {idempotencyKey: string}): Promise<{url: string}>;
}

export interface BillingRouteDependencies {
  authorize(): Promise<AuthorizedRequest>;
  repository: BillingRepository;
  stripe: BillingStripeGateway;
  appUrl: string;
  priceIds: {starter: string; growth: string; metered: string};
}

type Handler = (request: Request) => Promise<Response>;

async function context(deps: BillingRouteDependencies) {
  const authorization = await deps.authorize();
  if (!authorization.ok) return authorization.response;
  const organizationId = authorization.user.organizationId;
  if (!organizationId) return apiError('FORBIDDEN', 'Organization membership is required', 403);
  const [organization, restaurantId] = await Promise.all([
    deps.repository.getOrganizationBilling(organizationId),
    deps.repository.getRestaurantIdForOrganization(organizationId),
  ]);
  if (!organization || !restaurantId) return apiError('NOT_FOUND', 'Billing account was not found', 404);
  return {user: authorization.user, organization, restaurantId};
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

export function createCheckoutHandler(deps: BillingRouteDependencies): Handler {
  return wrap(async (request) => {
    const body = await parseJsonBody(request, checkoutSchema);
    if (!body.ok) return body.response;
    const billing = await context(deps);
    if (billing instanceof Response) return billing;

    let customerId = billing.organization.stripeCustomerId;
    if (!customerId) {
      const customer = await deps.stripe.createCustomer({
        name: billing.organization.name,
        email: billing.user.email,
        restaurantId: billing.restaurantId,
      }, {idempotencyKey: `customer:${billing.organization.id}`});
      customerId = customer.id;
      await deps.repository.setOrganizationStripeCustomerId(billing.organization.id, customerId);
    }

    const session = await deps.stripe.createCheckoutSession({
      customerId,
      basePriceId: deps.priceIds[body.data.plan],
      meteredPriceId: deps.priceIds.metered,
      successUrl: `${deps.appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${deps.appUrl}/billing/cancel`,
      restaurantId: billing.restaurantId,
    }, {idempotencyKey: `checkout:${billing.organization.id}:${body.data.plan}`});
    if (!session.url) return apiError('PROVIDER_ERROR', 'Stripe Checkout returned no redirect URL', 502);
    return Response.json({url: session.url});
  });
}

export function createPortalHandler(deps: BillingRouteDependencies): Handler {
  return wrap(async (request) => {
    void request;
    const billing = await context(deps);
    if (billing instanceof Response) return billing;
    const customerId = billing.organization.stripeCustomerId;
    if (!customerId) return apiError('BILLING_NOT_CONFIGURED', 'Complete checkout before opening the billing portal', 409);
    const session = await deps.stripe.createPortalSession({
      customerId,
      returnUrl: `${deps.appUrl}/settings`,
    }, {idempotencyKey: `portal:${billing.organization.id}`});
    return Response.json({url: session.url});
  });
}
