import {z} from 'zod';

import type {AuthorizedRequest} from '@/lib/api/auth';
import {apiError, internalApiError} from '@/lib/api/errors';
import type {RateLimitDecision} from '@/lib/api/rate-limit';
import type {PersistentRateLimiter} from '@/lib/api/rate-limit';
import {rateLimitedResponse} from '@/lib/api/rate-limit';
import {parseJsonBody, readBodyLimited, requestIp, validateMutationOrigin} from '@/lib/api/request';

export const importRequestSchema = z.object({
  restaurantId: z.string().uuid(),
  url: z.string().max(2_048).url(),
}).strict();

const menuRowSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  priceCents: z.number().int().nonnegative(),
  category: z.string().trim().min(1),
  dietaryTags: z.array(z.string()).default([]),
}).strict();
const hoursRowSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  openTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u),
  closeTime: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/u),
}).strict();
const faqRowSchema = z.object({
  question: z.string().trim().min(1),
  answer: z.string().trim().min(1),
  language: z.enum(['en', 'en-IN', 'fr-CA', 'ur', 'hi', 'pa', 'te', 'ar']),
}).strict();

export const importExtractionSchema = z.object({
  menu: z.array(menuRowSchema),
  menuComplete: z.boolean(),
  hours: z.array(hoursRowSchema),
  faqs: z.array(faqRowSchema),
}).strict();

const extractionJsonSchema = {
  type: 'object',
  properties: {
    menu: {type: 'array', items: {type: 'object', properties: {
      name: {type: 'string'}, description: {type: 'string'}, priceCents: {type: 'integer'},
      category: {type: 'string'}, dietaryTags: {type: 'array', items: {type: 'string'}},
    }, required: ['name', 'description', 'priceCents', 'category', 'dietaryTags']}},
    menuComplete: {type: 'boolean'},
    hours: {type: 'array', items: {type: 'object', properties: {
      weekday: {type: 'integer'}, openTime: {type: 'string'}, closeTime: {type: 'string'},
    }, required: ['weekday', 'openTime', 'closeTime']}},
    faqs: {type: 'array', items: {type: 'object', properties: {
      question: {type: 'string'}, answer: {type: 'string'}, language: {type: 'string'},
    }, required: ['question', 'answer', 'language']}},
  },
  required: ['menu', 'menuComplete', 'hours', 'faqs'],
} as const;

interface ImportRepository {
  findRestaurantOrganizationId(restaurantId: string): Promise<string | null>;
  createImportJob(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getImportJob(id: string): Promise<Record<string, unknown> | null>;
  updateImportJob(id: string, value: Record<string, unknown>): Promise<void>;
  claimImportExtraction(id: string): Promise<boolean>;
  saveImportReviewRows(jobId: string, restaurantId: string, rows: readonly Record<string, unknown>[]): Promise<void>;
}

interface ImportLimiter {consume(key: string): RateLimitDecision}
interface StartFirecrawl {
  startCrawl(input: {url: string}): Promise<{id: string}>;
}
interface StatusFirecrawl {
  getCrawl(id: string): Promise<{status: string; data?: unknown[]}>;
  scrape(input: Record<string, unknown>): Promise<{data: {markdown?: string}}>;
}
interface ImportGemini {
  generateStructured(input: {
    prompt: string;
    schema: Readonly<Record<string, unknown>>;
    resultSchema: z.ZodType<unknown>;
    maxOutputTokens: number;
    inlineData?: {mimeType: string; data: string};
  }): Promise<{json: unknown}>;
}

export interface ImportPostDependencies {
  authorize(): Promise<AuthorizedRequest>;
  limiter: ImportLimiter;
  repository: ImportRepository;
  firecrawl: StartFirecrawl;
  validateUrl(input: string): Promise<string>;
  organizationLimiter: PersistentRateLimiter;
}

export interface ImportStatusDependencies {
  authorize(): Promise<AuthorizedRequest>;
  limiter: ImportLimiter;
  repository: ImportRepository;
  firecrawl: StatusFirecrawl;
  gemini: ImportGemini;
  validateUrl(input: string): Promise<string>;
}

export interface ImportFileDependencies {
  authorize(): Promise<AuthorizedRequest>;
  limiter: ImportLimiter;
  repository: ImportRepository;
  gemini: ImportGemini;
}

function enforceLimit(limiter: ImportLimiter, key: string): Response | undefined {
  const decision = limiter.consume(key);
  return decision.allowed ? undefined : rateLimitedResponse(decision.retryAfterSeconds);
}

export function createImportPostHandler(dependencies: ImportPostDependencies) {
  return async (request: Request): Promise<Response> => {
    const ipLimited = enforceLimit(dependencies.limiter, `import:ip:${requestIp(request)}`);
    if (ipLimited) return ipLimited;
    const authorized = await dependencies.authorize();
    if (!authorized.ok) return authorized.response;
    const userLimited = enforceLimit(dependencies.limiter, `import:user:${authorized.user.id}`);
    if (userLimited) return userLimited;

    const parsed = await parseJsonBody(request, importRequestSchema);
    if (!parsed.ok) return parsed.response;
    if (!authorized.user.organizationId) return apiError('FORBIDDEN', 'Organization access is required', 403);

    try {
      const ownerOrganizationId = await dependencies.repository
        .findRestaurantOrganizationId(parsed.data.restaurantId);
      if (ownerOrganizationId !== authorized.user.organizationId) {
        return apiError('NOT_FOUND', 'Restaurant not found', 404);
      }
      const organizationLimit = await dependencies.organizationLimiter.consume({
        scope: 'import-job',
        key: authorized.user.organizationId,
        limit: 10,
        windowSeconds: 3_600,
      });
      if (!organizationLimit.allowed) return rateLimitedResponse(organizationLimit.retryAfterSeconds);
      let validatedUrl: string;
      try {
        validatedUrl = await dependencies.validateUrl(parsed.data.url);
      } catch {
        return apiError('INVALID_URL', 'Website URL is not allowed', 400);
      }
      const providerJob = await dependencies.firecrawl.startCrawl({url: validatedUrl});
      const job = await dependencies.repository.createImportJob({
        organization_id: authorized.user.organizationId,
        restaurant_id: parsed.data.restaurantId,
        requested_by: authorized.user.id,
        source_url: validatedUrl,
        provider_job_id: providerJob.id,
        status: 'processing',
      });
      if (typeof job.id !== 'string') throw new Error('Import job has no id');
      return Response.json({id: job.id, status: 'processing'}, {status: 202});
    } catch (error) {
      if (error instanceof Error && error.message === 'Import job has no id') return internalApiError();
      return apiError('PROVIDER_ERROR', 'Website import provider request failed', 502);
    }
  };
}

const acceptedMenuFileTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const maximumMenuFileBytes = 10 * 1024 * 1024;

export function createImportFileHandler(dependencies: ImportFileDependencies) {
  return async (request: Request): Promise<Response> => {
    const originError = validateMutationOrigin(request);
    if (originError) return originError;
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
      return apiError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be multipart/form-data', 415);
    }
    const limitedBody = await readBodyLimited(request, 11 * 1_024 * 1_024);
    if (!limitedBody.ok) return limitedBody.response;
    const ipLimited = enforceLimit(dependencies.limiter, `import-file:ip:${requestIp(request)}`);
    if (ipLimited) return ipLimited;
    const authorized = await dependencies.authorize();
    if (!authorized.ok) return authorized.response;
    const userLimited = enforceLimit(dependencies.limiter, `import-file:user:${authorized.user.id}`);
    if (userLimited) return userLimited;
    if (!authorized.user.organizationId) return apiError('FORBIDDEN', 'Organization access is required', 403);

    try {
      const form = await new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: limitedBody.bytes.slice().buffer as ArrayBuffer,
      }).formData();
      const restaurantId = form.get('restaurantId');
      const file = form.get('menuFile');
      if (typeof restaurantId !== 'string' || !z.string().uuid().safeParse(restaurantId).success) {
        return apiError('VALIDATION_ERROR', 'A valid restaurant is required', 400);
      }
      if (!(file instanceof File) || !acceptedMenuFileTypes.has(file.type) || file.size === 0 || file.size > maximumMenuFileBytes) {
        return apiError('VALIDATION_ERROR', 'Upload a PDF, JPEG, PNG, or WebP menu up to 10 MB', 400);
      }
      if (await dependencies.repository.findRestaurantOrganizationId(restaurantId) !== authorized.user.organizationId) {
        return apiError('NOT_FOUND', 'Restaurant not found', 404);
      }

      const job = await dependencies.repository.createImportJob({
        organization_id: authorized.user.organizationId,
        restaurant_id: restaurantId,
        requested_by: authorized.user.id,
        source_url: `upload://menu/${encodeURIComponent(file.name || 'menu')}`,
        provider_job_id: null,
        status: 'extracting',
      });
      if (typeof job.id !== 'string') return internalApiError();

      // Gemini accepts inline PDF/image bytes for document and image understanding.
      // https://ai.google.dev/gemini-api/docs/file-input-methods#inline_data
      const generated = await dependencies.gemini.generateStructured({
        prompt: 'Extract every visible restaurant menu item, category, description, price, weekly hour, and FAQ. Do not infer missing facts. Set menuComplete to false if any visible menu item, category, page, or price cannot be extracted reliably.',
        inlineData: {mimeType: file.type, data: Buffer.from(await file.arrayBuffer()).toString('base64')},
        schema: extractionJsonSchema,
        resultSchema: importExtractionSchema,
        maxOutputTokens: 4096,
      });
      const parsed = importExtractionSchema.safeParse(generated.json);
      if (!parsed.success) {
        await dependencies.repository.updateImportJob(job.id, {status: 'failed', error: 'Extraction schema mismatch'});
        return apiError('SCHEMA_MISMATCH', 'Menu extraction did not match the expected schema', 502);
      }
      const rows = reviewRows(job.id, restaurantId, parsed.data);
      const summary = reviewSummary(parsed.data);
      await dependencies.repository.saveImportReviewRows(job.id, restaurantId, rows);
      await dependencies.repository.updateImportJob(job.id, {
        status: 'completed',
        result: {
          review_row_count: summary.reviewRowCount,
          review_counts: summary.reviewCounts,
          partial: summary.partial,
          incomplete_menu: summary.incompleteMenu,
        },
        error: null,
      });
      return Response.json({id: job.id, status: 'completed', ...summary});
    } catch {
      return apiError('PROVIDER_ERROR', 'Menu upload import failed', 502);
    }
  };
}

function stringField(job: Record<string, unknown>, name: string): string | undefined {
  const value = job[name];
  return typeof value === 'string' ? value : undefined;
}

const storedReviewSummarySchema = z.object({
  review_row_count: z.number().int().nonnegative(),
  review_counts: z.object({
    menu: z.number().int().nonnegative(),
    hours: z.number().int().nonnegative(),
    faqs: z.number().int().nonnegative(),
  }),
  partial: z.boolean(),
  incomplete_menu: z.boolean().optional(),
});

function storedReviewSummary(job: Record<string, unknown>) {
  const parsed = storedReviewSummarySchema.safeParse(job.result);
  if (!parsed.success) return {};
  return {
    reviewRowCount: parsed.data.review_row_count,
    reviewCounts: parsed.data.review_counts,
    partial: parsed.data.partial,
    incompleteMenu: parsed.data.incomplete_menu ?? false,
  };
}

function crawlContent(data: readonly unknown[]): {text: string; pdfUrl?: string} {
  const markdown: string[] = [];
  let pdfUrl: string | undefined;
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.markdown === 'string' && row.markdown.trim()) markdown.push(row.markdown);
    const metadata = row.metadata && typeof row.metadata === 'object'
      ? row.metadata as Record<string, unknown> : undefined;
    const candidate = [metadata?.sourceURL, metadata?.url, row.url]
      .find((value): value is string => typeof value === 'string' && /\.pdf(?:$|[?#])/iu.test(value));
    if (candidate) pdfUrl = candidate;
  }
  return {text: markdown.join('\n\n'), ...(pdfUrl ? {pdfUrl} : {})};
}

function reviewRows(jobId: string, restaurantId: string, extraction: z.infer<typeof importExtractionSchema>) {
  return [
    ...extraction.menu.map((payload) => ({job_id: jobId, restaurant_id: restaurantId, kind: 'menu', payload, status: 'pending'})),
    ...extraction.hours.map((payload) => ({job_id: jobId, restaurant_id: restaurantId, kind: 'hours', payload, status: 'pending'})),
    ...extraction.faqs.map((payload) => ({job_id: jobId, restaurant_id: restaurantId, kind: 'faq', payload, status: 'pending'})),
  ];
}

function reviewSummary(extraction: z.infer<typeof importExtractionSchema>) {
  const reviewCounts = {
    menu: extraction.menu.length,
    hours: extraction.hours.length,
    faqs: extraction.faqs.length,
  };
  return {
    reviewRowCount: reviewCounts.menu + reviewCounts.hours + reviewCounts.faqs,
    reviewCounts,
    partial: !extraction.menuComplete || Object.values(reviewCounts).some((count) => count === 0),
    incompleteMenu: !extraction.menuComplete,
  };
}

export function createImportStatusHandler(dependencies: ImportStatusDependencies) {
  const inFlight = new Set<string>();

  return async (
    request: Request,
    context: {params: Promise<{id: string}>},
  ): Promise<Response> => {
    const ipLimited = enforceLimit(dependencies.limiter, `import-status:ip:${requestIp(request)}`);
    if (ipLimited) return ipLimited;
    const authorized = await dependencies.authorize();
    if (!authorized.ok) return authorized.response;
    const userLimited = enforceLimit(dependencies.limiter, `import-status:user:${authorized.user.id}`);
    if (userLimited) return userLimited;
    const {id} = await context.params;

    try {
      const job = await dependencies.repository.getImportJob(id);
      if (!job || stringField(job, 'organization_id') !== authorized.user.organizationId) {
        return apiError('NOT_FOUND', 'Import job not found', 404);
      }
      const storedStatus = stringField(job, 'status');
      if (storedStatus === 'completed' || storedStatus === 'failed') {
        return Response.json({
          id,
          status: storedStatus,
          ...(storedStatus === 'completed' ? storedReviewSummary(job) : {}),
        });
      }
      if (inFlight.has(id)) return Response.json({id, status: 'processing'}, {status: 202});

      const providerJobId = stringField(job, 'provider_job_id');
      const restaurantId = stringField(job, 'restaurant_id');
      const sourceUrl = stringField(job, 'source_url');
      if (!providerJobId || !restaurantId || !sourceUrl) return internalApiError();

      const crawl = await dependencies.firecrawl.getCrawl(providerJobId);
      if (crawl.status === 'scraping') return Response.json({id, status: 'processing'});
      if (crawl.status === 'failed' || crawl.status === 'cancelled') {
        await dependencies.repository.updateImportJob(id, {
          status: 'failed', error: `Firecrawl job ${crawl.status}`,
        });
        return Response.json({id, status: 'failed'});
      }
      if (crawl.status !== 'completed') {
        return apiError('SCHEMA_MISMATCH', 'Import provider response did not match the expected schema', 502);
      }

      if (!await dependencies.repository.claimImportExtraction(id)) {
        return Response.json({id, status: 'processing'}, {status: 202});
      }

      inFlight.add(id);
      try {
        const content = crawlContent(crawl.data ?? []);
        let text = content.text;
        if (!text) {
          // Firecrawl PDF parser request shape:
          // https://docs.firecrawl.dev/features/scrape#pdf-parsing
          const safeScrapeUrl = await dependencies.validateUrl(content.pdfUrl ?? sourceUrl);
          const scraped = await dependencies.firecrawl.scrape({
            url: safeScrapeUrl,
            formats: ['markdown'],
            parsers: [{type: 'pdf', mode: 'auto'}],
          });
          text = scraped.data.markdown ?? '';
        }
        if (!text.trim()) {
          await dependencies.repository.updateImportJob(id, {status: 'failed', error: 'No importable content found'});
          return apiError('SCHEMA_MISMATCH', 'Import extraction did not match the expected schema', 502);
        }

        // Gemini structured output contract:
        // https://ai.google.dev/gemini-api/docs/structured-output
        const generated = await dependencies.gemini.generateStructured({
          prompt: `Extract restaurant menu items, weekly hours, and FAQs from this source. Do not infer missing facts. Set menuComplete to false if any visible menu item, category, page, or price cannot be extracted reliably.\n\n${text}`,
          schema: extractionJsonSchema,
          resultSchema: importExtractionSchema,
          maxOutputTokens: 4096,
        });
        const parsed = importExtractionSchema.safeParse(generated.json);
        if (!parsed.success) {
          await dependencies.repository.updateImportJob(id, {status: 'failed', error: 'Extraction schema mismatch'});
          return apiError('SCHEMA_MISMATCH', 'Import extraction did not match the expected schema', 502);
        }
        const rows = reviewRows(id, restaurantId, parsed.data);
        const summary = reviewSummary(parsed.data);
        await dependencies.repository.saveImportReviewRows(id, restaurantId, rows);
        await dependencies.repository.updateImportJob(id, {
          status: 'completed',
          result: {
            review_row_count: summary.reviewRowCount,
            review_counts: summary.reviewCounts,
            partial: summary.partial,
            incomplete_menu: summary.incompleteMenu,
          },
          error: null,
        });
        return Response.json({id, status: 'completed', ...summary});
      } finally {
        inFlight.delete(id);
      }
    } catch {
      return apiError('PROVIDER_ERROR', 'Website import provider request failed', 502);
    }
  };
}
