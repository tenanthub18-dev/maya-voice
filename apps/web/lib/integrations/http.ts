import type { ZodType } from "zod";

type Fetch = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

const RETRYABLE_STATUS = (status: number): boolean =>
  status === 429 || status >= 500;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export class ApiError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;

  constructor(options: {
    provider: string;
    status: number;
    body: unknown;
    headers: Headers;
  }) {
    super(`${options.provider} API returned HTTP ${options.status}`);
    this.name = "ApiError";
    this.provider = options.provider;
    this.status = options.status;
    this.body = options.body;
    this.headers = options.headers;
  }
}

export interface RequestJsonOptions<T> {
  provider: string;
  url: string | URL;
  schema: ZodType<T>;
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  timeoutMs?: number;
  retries?: number;
  idempotencyKey?: string;
  retrySafe?: boolean;
  fetchFn?: Fetch;
  sleep?: Sleep;
  random?: () => number;
}

const defaultSleep: Sleep = async (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function retryAfterMilliseconds(value: string | null, now = Date.now()): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRetrySafe(
  method: string,
  idempotencyKey: string | undefined,
  retrySafe: boolean | undefined,
): boolean {
  return retrySafe === true || SAFE_METHODS.has(method) || idempotencyKey !== undefined;
}

async function requestWithParser<T>(
  options: RequestJsonOptions<T>,
  parseSuccess: (response: Response) => Promise<unknown>,
): Promise<T> {
  const method = (options.method ?? "GET").toUpperCase();
  const retries = options.retries ?? 2;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetchFn = options.fetchFn ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const headers = new Headers(options.headers);
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }

  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    let responseBody: unknown;
    try {
      response = await fetchFn(options.url, {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
      });
      if (response.ok) {
        return options.schema.parse(await parseSuccess(response));
      }
      responseBody = await parseResponseBody(response);
    } catch (error) {
      if (controller.signal.aborted) {
        const timeoutError = new Error(
          `${options.provider} API request timed out after ${timeoutMs}ms`,
        );
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const error = new ApiError({
      provider: options.provider,
      status: response.status,
      body: responseBody,
      headers: response.headers,
    });
    const canRetry =
      attempt < retries &&
      RETRYABLE_STATUS(response.status) &&
      isRetrySafe(method, options.idempotencyKey, options.retrySafe);
    if (!canRetry) throw error;

    // Retry-After is defined for both delta-seconds and HTTP-date values.
    // https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3
    const retryAfter = retryAfterMilliseconds(response.headers.get("Retry-After"));
    const exponentialWithJitter = 250 * 2 ** attempt * (0.5 + random());
    await sleep(retryAfter ?? exponentialWithJitter);
  }
}

export async function requestJson<T>(options: RequestJsonOptions<T>): Promise<T> {
  return requestWithParser(options, parseResponseBody);
}

export async function requestBinary<T>(options: RequestJsonOptions<T>): Promise<T> {
  return requestWithParser(options, async (response) =>
    new Uint8Array(await response.arrayBuffer()),
  );
}
