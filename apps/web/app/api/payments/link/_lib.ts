import {z} from 'zod';

import {apiError, internalApiError} from '@/lib/api/errors';
import {readBodyLimited} from '@/lib/api/request';
import {verifyWorkerRequest} from '@/lib/security/worker-hmac';

const paymentLinkSchema = z.object({
  restaurant_id: z.string().min(1),
  call_id: z.string().min(1),
  order_id: z.string().min(1).optional(),
  booking_id: z.string().min(1).optional(),
}).strict().refine((value) => Boolean(value.order_id) !== Boolean(value.booking_id), {
  message: 'Supply exactly one of order_id or booking_id',
});

interface PaymentTarget {
  kind: 'order' | 'booking';
  id: string;
  restaurantId: string;
  amountCents: number;
  paidStatus: 'unpaid' | 'paid' | 'refunded';
  connectedAccountId: string | null;
}

interface PaymentLinkRepository {
  getPaymentTarget(input: {restaurantId: string; kind: 'order' | 'booking'; id: string}): Promise<PaymentTarget | null>;
}

interface PaymentLinkStripeGateway {
  createConnectedPaymentLink(input: {
    connectedAccountId: string;
    amountCents: number;
    currency: 'cad';
    productName: string;
    restaurantId: string;
    target: {kind: 'order' | 'booking'; id: string};
  }, options: {idempotencyKey: string}): Promise<{url: string}>;
}

export interface PaymentLinkDependencies {
  repository: PaymentLinkRepository;
  stripe: PaymentLinkStripeGateway;
  secret: string;
  isEnabled(restaurantId: string): Promise<boolean>;
  nowSeconds?: () => number;
}

function parseBody(rawBody: string) {
  try {
    return paymentLinkSchema.safeParse(JSON.parse(rawBody) as unknown);
  } catch {
    return paymentLinkSchema.safeParse(undefined);
  }
}

export function createPaymentLinkHandler(deps: PaymentLinkDependencies): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const limited = await readBodyLimited(request, 16 * 1_024);
      if (!limited.ok) return limited.response;
      const rawBody = new TextDecoder().decode(limited.bytes);
      const timestamp = request.headers.get('x-timestamp');
      const signature = request.headers.get('x-signature');
      const path = new URL(request.url).pathname;
      if (!timestamp || !signature || !verifyWorkerRequest({
        secret: deps.secret,
        timestamp,
        signature,
        method: request.method,
        path,
        body: rawBody,
      }, deps.nowSeconds?.())) return apiError('INVALID_SIGNATURE', 'Worker signature is invalid', 401);

      const parsed = parseBody(rawBody);
      if (!parsed.success) return apiError('BAD_REQUEST', 'Payment link request is invalid', 400);
      const body = parsed.data;
      if (!await deps.isEnabled(body.restaurant_id)) {
        return apiError('feature_disabled', 'Diner payments are disabled', 403);
      }
      const kind = body.order_id ? 'order' : 'booking';
      const targetId = body.order_id ?? body.booking_id!;
      const target = await deps.repository.getPaymentTarget({restaurantId: body.restaurant_id, kind, id: targetId});
      if (!target) return apiError('not_found', 'Payment target was not found', 404);
      if (target.paidStatus === 'paid') return apiError('already_paid', 'Payment target is already paid', 409);
      if (!target.connectedAccountId) return apiError('not_connected', 'Stripe is not connected', 409);
      if (!Number.isSafeInteger(target.amountCents) || target.amountCents <= 0) {
        return apiError('payment_not_configured', 'Payment amount is not configured', 409);
      }
      const paymentLink = await deps.stripe.createConnectedPaymentLink({
        connectedAccountId: target.connectedAccountId,
        amountCents: target.amountCents,
        currency: 'cad',
        productName: `${kind === 'order' ? 'Order' : 'Booking deposit'} ${target.id}`,
        restaurantId: target.restaurantId,
        target: {kind, id: target.id},
      }, {idempotencyKey: `${body.call_id}:${target.id}`});
      return Response.json({url: paymentLink.url, target_id: target.id});
    } catch {
      return internalApiError();
    }
  };
}
