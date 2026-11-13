import {createHmac} from 'node:crypto';

export function callerReference(secret: string, restaurantId: string, callerPhone: string): string {
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('Privacy request hash secret must be at least 32 bytes');
  return createHmac('sha256', secret).update(`${restaurantId}:${callerPhone}`).digest('hex');
}
