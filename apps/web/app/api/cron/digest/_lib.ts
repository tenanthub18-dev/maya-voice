import {timingSafeEqual} from 'node:crypto';
import {getCurrentRestaurant} from '@/lib/restaurant';

export function createMockDigestRepository() {
  return {
    async listDailyDigestRecipients() {
      const restaurant = await getCurrentRestaurant();
      return [{
        id: 'mock-owner-preferences', email: 'owner@demo.local', locale: 'en' as const,
        restaurantName: restaurant.name, calls: 3, bookings: 1, orders: 1, messages: 1, flagged: 0,
      }];
    },
    async markDigestDelivered() {},
  };
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createDigestCronHandler(deps: {secret: string; run: () => Promise<{sent: number; failed: number}>}) {
  return async (request: Request): Promise<Response> => {
    const authorization = request.headers.get('authorization');
    const presented = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!presented || !equalSecret(presented, deps.secret)) {
      return Response.json({error: {code: 'UNAUTHORIZED', message: 'Invalid cron authorization'}}, {status: 401});
    }
    return Response.json(await deps.run());
  };
}
