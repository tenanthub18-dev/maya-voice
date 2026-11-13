import {createHmac} from 'node:crypto';

export interface TestCallTokenInput {
  agentVersionId: string;
  restaurantId: string;
}

export function createTestCallToken(
  input: TestCallTokenInput,
  secret: string,
  clock: () => number = Date.now,
): string {
  const claims = {
    exp: Math.floor(clock() / 1000) + 60,
    mode: 'test',
    agent_version_id: input.agentVersionId,
    restaurant_id: input.restaurantId,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${signature}`;
}
