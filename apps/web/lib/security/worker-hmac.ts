import {createHash, createHmac, timingSafeEqual} from 'node:crypto';

const TOLERANCE_SECONDS = 300;

interface WorkerRequestInput {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
}

function canonical(input: WorkerRequestInput): string {
  const bodyHash = createHash('sha256').update(input.body).digest('hex');
  return `${input.timestamp}\n${input.method.toUpperCase()}\n${input.path}\n${bodyHash}`;
}

export function signWorkerRequest(input: WorkerRequestInput): {timestamp: string; signature: string} {
  const digest = createHmac('sha256', input.secret).update(canonical(input)).digest('hex');
  return {timestamp: input.timestamp, signature: `sha256=${digest}`};
}

export function verifyWorkerRequest(
  input: WorkerRequestInput & {signature: string},
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): boolean {
  if (!/^\d{10}$/u.test(input.timestamp)) return false;
  const timestamp = Number(input.timestamp);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) return false;
  const supplied = input.signature.match(/^sha256=([a-f0-9]{64})$/u)?.[1];
  if (!supplied) return false;
  const expected = signWorkerRequest(input).signature.slice('sha256='.length);
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}
