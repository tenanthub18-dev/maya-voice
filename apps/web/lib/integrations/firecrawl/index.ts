import {z} from 'zod';

import {requestJson} from '../http';

type Fetch = typeof fetch;
type JsonObject = Readonly<Record<string, unknown>>;

export interface ScrapeRequest extends JsonObject {url: string}
export interface CrawlRequest extends JsonObject {url: string}
export interface MapRequest extends JsonObject {url: string}
export interface ExtractRequest extends JsonObject {urls: readonly string[]}

const scrapeResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    markdown: z.string().optional(),
    json: z.unknown().optional(),
    metadata: z.object({statusCode: z.number().optional()}).passthrough(),
  }).passthrough(),
}).passthrough();

const crawlStartSchema = z.object({
  success: z.literal(true), id: z.string(), url: z.string(),
}).passthrough();

// VERIFY: Firecrawl publishes field names but not literal complete status examples.
// Keep optional result fields permissive until a live response is captured.
const crawlStatusSchema = z.object({
  status: z.enum(['scraping', 'completed', 'failed', 'cancelled']),
  total: z.number().optional(), completed: z.number().optional(),
  creditsUsed: z.number().optional(), next: z.string().optional(),
  data: z.array(z.unknown()).optional(),
}).passthrough();

const mapResponseSchema = z.object({
  success: z.literal(true),
  links: z.array(z.object({url: z.string(), title: z.string().optional(), description: z.string().optional()}).passthrough()),
}).passthrough();

const extractStartSchema = z.object({
  success: z.literal(true), id: z.string(), invalidURLs: z.array(z.string()).optional(),
}).passthrough();

// VERIFY: schema-derived fixture; retain unknown extracted data and extra metadata.
const extractStatusSchema = z.object({
  success: z.boolean().optional(),
  status: z.enum(['processing', 'completed', 'failed', 'cancelled']),
  data: z.unknown().optional(),
}).passthrough();

export type ScrapeResponse = z.infer<typeof scrapeResponseSchema>;
export type CrawlStatus = z.infer<typeof crawlStatusSchema>;
export type ExtractStatus = z.infer<typeof extractStatusSchema>;

export interface FirecrawlClientOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  request?: {timeoutMs?: number; retries?: number; sleep?: (milliseconds: number) => Promise<void>; random?: () => number};
}

interface PollOptions {timeoutMs: number; intervalMs: number}

export function createFirecrawlClient(options: FirecrawlClientOptions) {
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const sleep = options.sleep ?? (async (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = options.now ?? Date.now;
  const headers = {Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json'};

  const post = <T>(path: string, body: JsonObject, schema: z.ZodType<T>) => requestJson({
    provider: 'firecrawl', url: `${baseUrl}${path}`, method: 'POST', headers,
    body: JSON.stringify(body), schema, fetchFn: options.fetch,
    ...options.request,
  });
  const get = <T>(path: string, schema: z.ZodType<T>, timeoutMs?: number) => requestJson({
    provider: 'firecrawl', url: `${baseUrl}${path}`, headers, schema, fetchFn: options.fetch,
    ...options.request,
    ...(timeoutMs === undefined ? {} : {
      timeoutMs: Math.min(options.request?.timeoutMs ?? timeoutMs, timeoutMs),
    }),
  });

  // https://docs.firecrawl.dev/api-reference/endpoint/scrape
  const scrape = (body: ScrapeRequest) => post('/scrape', body, scrapeResponseSchema);
  // https://docs.firecrawl.dev/api-reference/endpoint/crawl-post
  const startCrawl = (body: CrawlRequest) => post('/crawl', body, crawlStartSchema);
  // https://docs.firecrawl.dev/api-reference/endpoint/crawl-get
  const getCrawl = (id: string, timeoutMs?: number) =>
    get(`/crawl/${encodeURIComponent(id)}`, crawlStatusSchema, timeoutMs);
  // https://docs.firecrawl.dev/api-reference/endpoint/map
  const map = (body: MapRequest) => post('/map', body, mapResponseSchema);
  // https://docs.firecrawl.dev/api-reference/endpoint/extract
  const startExtract = (body: ExtractRequest) => post('/extract', body, extractStartSchema);
  // https://docs.firecrawl.dev/api-reference/endpoint/extract-get
  const getExtract = (id: string, timeoutMs?: number) =>
    get(`/extract/${encodeURIComponent(id)}`, extractStatusSchema, timeoutMs);

  async function poll<T extends {status: string}>(
    operation: (timeoutMs: number) => Promise<T>, terminal: ReadonlySet<string>, config: PollOptions,
  ): Promise<T> {
    const startedAt = now();
    for (;;) {
      const remainingBeforeRequest = config.timeoutMs - (now() - startedAt);
      if (remainingBeforeRequest <= 0) throw new Error('Firecrawl polling timed out');
      const response = await operation(remainingBeforeRequest);
      if (terminal.has(response.status)) return response;
      const remainingAfterRequest = config.timeoutMs - (now() - startedAt);
      if (remainingAfterRequest <= 0) throw new Error('Firecrawl polling timed out');
      await sleep(Math.min(config.intervalMs, remainingAfterRequest));
    }
  }

  return {
    scrape, startCrawl, getCrawl, map, startExtract, getExtract,
    pollCrawl: (id: string, config: PollOptions) => poll(
      (timeoutMs) => getCrawl(id, timeoutMs), new Set(['completed', 'failed', 'cancelled']), config,
    ),
    pollExtract: (id: string, config: PollOptions) => poll(
      (timeoutMs) => getExtract(id, timeoutMs), new Set(['completed', 'failed', 'cancelled']), config,
    ),
  };
}
