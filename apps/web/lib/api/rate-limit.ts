export interface TokenBucketOptions {
  capacity: number;
  refillPerSecond: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface FixedWindowRateLimitRequest {
  scope: string;
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface PersistentRateLimiter {
  consume(input: FixedWindowRateLimitRequest): Promise<RateLimitDecision>;
}

interface FixedWindow {count: number; resetAt: number}

export class InMemoryFixedWindowRateLimiter implements PersistentRateLimiter {
  readonly #now: () => number;
  readonly #store: Map<string, FixedWindow>;

  constructor(options: {now?: () => number; store?: Map<string, FixedWindow>} = {}) {
    this.#now = options.now ?? Date.now;
    this.#store = options.store ?? new Map();
  }

  async consume(input: FixedWindowRateLimitRequest): Promise<RateLimitDecision> {
    if (input.limit <= 0 || input.windowSeconds <= 0) throw new Error('Rate limit and window must be positive');
    const now = this.#now();
    const storageKey = `${input.scope}:${input.key}`;
    const current = this.#store.get(storageKey);
    const window = !current || now >= current.resetAt
      ? {count: 0, resetAt: now + input.windowSeconds * 1_000}
      : current;
    if (window.count >= input.limit) {
      this.#store.set(storageKey, window);
      return {allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000))};
    }
    this.#store.set(storageKey, {...window, count: window.count + 1});
    return {allowed: true, retryAfterSeconds: 0};
  }
}

interface SupabaseRateLimitClient {
  rpc(name: string, input: Record<string, unknown>): PromiseLike<{
    data: unknown;
    error: {message?: string} | null;
  }>;
}

export class SupabaseFixedWindowRateLimiter implements PersistentRateLimiter {
  readonly #client: SupabaseRateLimitClient;

  constructor(client: SupabaseRateLimitClient) {
    this.#client = client;
  }

  async consume(input: FixedWindowRateLimitRequest): Promise<RateLimitDecision> {
    const {data, error} = await this.#client.rpc('consume_rate_limit', {
      p_scope: input.scope,
      p_key: input.key,
      p_limit: input.limit,
      p_window_seconds: input.windowSeconds,
    });
    if (error) throw new Error('Persistent rate limiter failed');
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row !== 'object') throw new Error('Persistent rate limiter returned invalid data');
    const value = row as Record<string, unknown>;
    if (typeof value.allowed !== 'boolean' || typeof value.retry_after_seconds !== 'number') {
      throw new Error('Persistent rate limiter returned invalid data');
    }
    return {allowed: value.allowed, retryAfterSeconds: value.retry_after_seconds};
  }
}

interface Bucket {tokens: number; updatedAt: number}

export class TokenBucketRateLimiter {
  readonly #capacity: number;
  readonly #refillPerMillisecond: number;
  readonly #now: () => number;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: TokenBucketOptions) {
    if (options.capacity <= 0 || options.refillPerSecond <= 0) {
      throw new Error('Token bucket capacity and refill rate must be positive');
    }
    this.#capacity = options.capacity;
    this.#refillPerMillisecond = options.refillPerSecond / 1_000;
    this.#now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitDecision {
    const now = this.#now();
    const previous = this.#buckets.get(key) ?? {tokens: this.#capacity, updatedAt: now};
    const tokens = Math.min(
      this.#capacity,
      previous.tokens + Math.max(0, now - previous.updatedAt) * this.#refillPerMillisecond,
    );
    if (tokens < 1) {
      this.#buckets.set(key, {tokens, updatedAt: now});
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / this.#refillPerMillisecond / 1_000)),
      };
    }
    this.#buckets.set(key, {tokens: tokens - 1, updatedAt: now});
    return {allowed: true, retryAfterSeconds: 0};
  }
}

export function rateLimitedResponse(retryAfterSeconds: number): Response {
  return Response.json(
    {error: {code: 'RATE_LIMITED', message: 'Too many requests'}},
    {status: 429, headers: {'retry-after': String(retryAfterSeconds)}},
  );
}
