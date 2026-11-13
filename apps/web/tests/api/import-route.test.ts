import {describe, expect, it, vi} from 'vitest';

import {
  createImportFileHandler,
  createImportPostHandler,
  createImportStatusHandler,
} from '@/app/api/import/_lib/workflow';

const restaurantId = '11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const user = {id: 'user-1', email: 'owner@example.com', role: 'owner' as const, organizationId};

function jsonRequest(body: unknown, ip = '203.0.113.8') {
  return new Request('http://localhost/api/import', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-forwarded-for': ip},
    body: JSON.stringify(body),
  });
}

function repository() {
  return {
    findRestaurantOrganizationId: vi.fn(async () => organizationId as string | null),
    createImportJob: vi.fn(async (value: Record<string, unknown>) => ({id: 'job-1', ...value})),
    getImportJob: vi.fn(async () => ({
      id: 'job-1', organization_id: organizationId, restaurant_id: restaurantId,
      requested_by: user.id, source_url: 'https://restaurant.example',
      provider_job_id: 'crawl-1', status: 'processing',
    }) as Record<string, unknown> | null),
    updateImportJob: vi.fn(async () => undefined),
    claimImportExtraction: vi.fn(async () => true),
    saveImportReviewRows: vi.fn(async () => undefined),
  };
}

const allow = {consume: vi.fn((key: string) => {
  void key;
  return {allowed: true, retryAfterSeconds: 0};
})};
const allowOrganization = {consume: vi.fn(async () => ({allowed: true, retryAfterSeconds: 0}))};

describe('POST /api/import', () => {
  it('starts a crawl, persists the owned import, and rate-limits the IP and user', async () => {
    const repo = repository();
    const limiter = {consume: vi.fn((key: string) => {
      void key;
      return {allowed: true, retryAfterSeconds: 0};
    })};
    const startCrawl = vi.fn(async () => ({success: true as const, id: 'crawl-1', url: 'https://provider/crawl-1'}));
    const validateUrl = vi.fn(async (url: string) => url);
    const handler = createImportPostHandler({
      authorize: async () => ({ok: true as const, user}), limiter, repository: repo,
      firecrawl: {startCrawl}, validateUrl, organizationLimiter: allowOrganization,
    });

    const response = await handler(jsonRequest({restaurantId, url: 'https://restaurant.example'}));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({id: 'job-1', status: 'processing'});
    expect(startCrawl).toHaveBeenCalledWith({url: 'https://restaurant.example'});
    expect(validateUrl).toHaveBeenCalledWith('https://restaurant.example');
    expect(repo.createImportJob).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: organizationId, restaurant_id: restaurantId, requested_by: user.id,
      source_url: 'https://restaurant.example', provider_job_id: 'crawl-1', status: 'processing',
    }));
    expect(limiter.consume.mock.calls.map(([key]) => key)).toEqual([
      'import:ip:203.0.113.8', 'import:user:user-1',
    ]);
  });

  it('rejects invalid input, signed-out callers, staff, wrong organizations, and rate limits', async () => {
    const repo = repository();
    const base = {limiter: allow, organizationLimiter: allowOrganization, repository: repo, firecrawl: {startCrawl: vi.fn()}, validateUrl: async (url: string) => url};

    const invalid = createImportPostHandler({...base, authorize: async () => ({ok: true as const, user})});
    expect((await invalid(jsonRequest({restaurantId: 'bad', url: 'file:///menu.pdf'}))).status).toBe(400);

    const unauthorized = createImportPostHandler({...base, authorize: async () => ({
      ok: false as const,
      response: Response.json({error: {code: 'UNAUTHORIZED', message: 'Authentication required'}}, {status: 401}),
    })});
    expect((await unauthorized(jsonRequest({restaurantId, url: 'https://restaurant.example'}))).status).toBe(401);

    const forbidden = createImportPostHandler({...base, authorize: async () => ({
      ok: false as const,
      response: Response.json({error: {code: 'FORBIDDEN', message: 'Insufficient permissions'}}, {status: 403}),
    })});
    expect((await forbidden(jsonRequest({restaurantId, url: 'https://restaurant.example'}))).status).toBe(403);

    repo.findRestaurantOrganizationId.mockResolvedValueOnce('different-org');
    const wrongOrg = createImportPostHandler({...base, authorize: async () => ({ok: true as const, user})});
    expect((await wrongOrg(jsonRequest({restaurantId, url: 'https://restaurant.example'}))).status).toBe(404);

    const limited = createImportPostHandler({
      ...base, authorize: async () => ({ok: true as const, user}),
      limiter: {consume: vi.fn((key: string) => {
        void key;
        return {allowed: false, retryAfterSeconds: 7};
      })},
    });
    const limitedResponse = await limited(jsonRequest({restaurantId, url: 'https://restaurant.example'}));
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('7');
  });

  it('returns the uniform provider error without persisting a job', async () => {
    const repo = repository();
    const handler = createImportPostHandler({
      authorize: async () => ({ok: true as const, user}), limiter: allow, repository: repo,
      organizationLimiter: allowOrganization,
      validateUrl: async (url: string) => url,
      firecrawl: {startCrawl: vi.fn(async () => { throw new Error('provider unavailable'); })},
    });
    const response = await handler(jsonRequest({restaurantId, url: 'https://restaurant.example'}));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: {code: 'PROVIDER_ERROR', message: 'Website import provider request failed'},
    });
    expect(repo.createImportJob).not.toHaveBeenCalled();
  });

  it('rejects a URL that fails SSRF validation before contacting Firecrawl', async () => {
    const repo = repository();
    const startCrawl = vi.fn();
    const handler = createImportPostHandler({
      authorize: async () => ({ok: true as const, user}), limiter: allow, repository: repo,
      organizationLimiter: allowOrganization,
      validateUrl: async () => { throw new Error('URL is not allowed'); },
      firecrawl: {startCrawl},
    });

    const response = await handler(jsonRequest({restaurantId, url: 'https://private.example/menu'}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: {code: 'INVALID_URL', message: 'Website URL is not allowed'},
    });
    expect(startCrawl).not.toHaveBeenCalled();
    expect(repo.createImportJob).not.toHaveBeenCalled();
  });

  it('enforces ten import jobs per hour per organization', async () => {
    const repo = repository();
    const startCrawl = vi.fn();
    const organizationLimiter = {consume: vi.fn(async () => ({allowed: false, retryAfterSeconds: 900}))};
    const handler = createImportPostHandler({
      authorize: async () => ({ok: true as const, user}), limiter: allow, organizationLimiter,
      repository: repo, validateUrl: async (url) => url, firecrawl: {startCrawl},
    });

    const response = await handler(jsonRequest({restaurantId, url: 'https://restaurant.example'}));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('900');
    expect(organizationLimiter.consume).toHaveBeenCalledWith({
      scope: 'import-job', key: organizationId, limit: 10, windowSeconds: 3_600,
    });
    expect(startCrawl).not.toHaveBeenCalled();
  });
});

describe('POST /api/import/file', () => {
  it('extracts an owned PDF menu into durable review rows', async () => {
    const repo = repository();
    const generateStructured = vi.fn(async () => ({json: {
      menu: [{name: 'Dal', description: '', priceCents: 1299, category: 'Mains', dietaryTags: []}],
      menuComplete: false,
      hours: [],
      faqs: [],
    }}));
    const handler = createImportFileHandler({
      authorize: async () => ({ok: true as const, user}), limiter: allow, repository: repo,
      gemini: {generateStructured},
    });
    const form = new FormData();
    form.set('restaurantId', restaurantId);
    form.set('menuFile', new File(['%PDF menu'], 'menu.pdf', {type: 'application/pdf'}));

    const response = await handler(new Request('http://localhost/api/import/file', {method: 'POST', body: form}));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: 'job-1', status: 'completed', partial: true, incompleteMenu: true,
      reviewCounts: {menu: 1, hours: 0, faqs: 0},
    });
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({
      inlineData: expect.objectContaining({mimeType: 'application/pdf'}),
    }));
    expect(repo.saveImportReviewRows).toHaveBeenCalledWith('job-1', restaurantId, [
      expect.objectContaining({kind: 'menu', status: 'pending'}),
    ]);
  });

  it('rejects unsupported or oversized menu files before creating a job', async () => {
    const repo = repository();
    const handler = createImportFileHandler({
      authorize: async () => ({ok: true as const, user}), limiter: allow, repository: repo,
      gemini: {generateStructured: vi.fn()},
    });
    const form = new FormData();
    form.set('restaurantId', restaurantId);
    form.set('menuFile', new File(['text'], 'menu.txt', {type: 'text/plain'}));

    expect((await handler(new Request('http://localhost/api/import/file', {method: 'POST', body: form}))).status).toBe(400);
    expect(repo.createImportJob).not.toHaveBeenCalled();
  });
});

describe('GET /api/import/[id]', () => {
  function statusHandler(options: {
    crawl?: {status: string; data?: unknown[]};
    extracted?: unknown;
    repo?: ReturnType<typeof repository>;
    scrape?: (input: Record<string, unknown>) => Promise<{data: {markdown?: string}}>;
  } = {}) {
    const repo = options.repo ?? repository();
    const scrape = vi.fn(options.scrape ?? (async () => ({
      data: {markdown: '# PDF menu'},
    })));
    const getCrawl = vi.fn(async () => options.crawl ?? ({status: 'scraping'}));
    const generateStructured = vi.fn(async () => ({response: {}, json: options.extracted ?? {
      menu: [{name: 'Dal', category: 'Mains', priceCents: 1299, dietaryTags: ['vegetarian']}],
      menuComplete: true,
      hours: [{weekday: 1, openTime: '11:00', closeTime: '22:00'}],
      faqs: [{question: 'Halal?', answer: 'Yes', language: 'en'}],
    }}));
    const handler = createImportStatusHandler({
      authorize: async () => ({ok: true as const, user}), limiter: allow, repository: repo,
      firecrawl: {getCrawl, scrape}, gemini: {generateStructured}, validateUrl: async (url: string) => url,
    });
    return {handler, repo, scrape, getCrawl, generateStructured};
  }

  const context = {params: Promise.resolve({id: 'job-1'})};

  it('returns pending status without extracting', async () => {
    const {handler, generateStructured} = statusHandler();
    const response = await handler(new Request('http://localhost/api/import/job-1'), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({id: 'job-1', status: 'processing'});
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('returns persisted partial-import metadata after the job has completed', async () => {
    const repo = repository();
    repo.getImportJob.mockResolvedValueOnce({
      id: 'job-1',
      organization_id: organizationId,
      restaurant_id: restaurantId,
      status: 'completed',
      result: {
        review_row_count: 2,
        review_counts: {menu: 1, hours: 1, faqs: 0},
        partial: true,
      },
    });
    const {handler, generateStructured} = statusHandler({repo});

    const response = await handler(new Request('http://localhost/api/import/job-1'), context);

    await expect(response.json()).resolves.toEqual({
      id: 'job-1',
      status: 'completed',
      reviewRowCount: 2,
      reviewCounts: {menu: 1, hours: 1, faqs: 0},
      partial: true,
      incompleteMenu: false,
    });
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it('extracts strict review rows and completes a finished crawl', async () => {
    const {handler, repo} = statusHandler({
      crawl: {status: 'completed', data: [{markdown: '# Menu\nDal $12.99'}]},
    });
    const response = await handler(new Request('http://localhost/api/import/job-1'), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      id: 'job-1',
      status: 'completed',
      reviewRowCount: 3,
      reviewCounts: {menu: 1, hours: 1, faqs: 1},
      partial: false,
      incompleteMenu: false,
    });
    expect(repo.saveImportReviewRows).toHaveBeenCalledWith(
      'job-1', restaurantId, expect.arrayContaining([
      expect.objectContaining({job_id: 'job-1', restaurant_id: restaurantId, kind: 'menu', status: 'pending'}),
      expect.objectContaining({kind: 'hours'}), expect.objectContaining({kind: 'faq'}),
      ]),
    );
    expect(repo.updateImportJob).toHaveBeenCalledWith('job-1', expect.objectContaining({status: 'completed'}));
  });

  it('marks a successful extraction as partial when a review section is empty', async () => {
    const {handler, repo} = statusHandler({
      crawl: {status: 'completed', data: [{markdown: '# Hours only'}]},
      extracted: {
        menu: [],
        menuComplete: true,
        hours: [{weekday: 1, openTime: '11:00', closeTime: '22:00'}],
        faqs: [],
      },
    });

    const response = await handler(new Request('http://localhost/api/import/job-1'), context);

    await expect(response.json()).resolves.toEqual({
      id: 'job-1',
      status: 'completed',
      reviewRowCount: 1,
      reviewCounts: {menu: 0, hours: 1, faqs: 0},
      partial: true,
      incompleteMenu: false,
    });
    expect(repo.updateImportJob).toHaveBeenCalledWith('job-1', expect.objectContaining({
      status: 'completed',
      result: {
        review_row_count: 1,
        review_counts: {menu: 0, hours: 1, faqs: 0},
        partial: true,
        incomplete_menu: false,
      },
    }));
  });

  it('uses the documented PDF scraper when crawl text is unavailable', async () => {
    const scrape = vi.fn(async () => ({
      success: true as const, data: {markdown: '# PDF menu', metadata: {statusCode: 200}},
    }));
    const {handler, generateStructured} = statusHandler({
      crawl: {status: 'completed', data: [{metadata: {sourceURL: 'https://restaurant.example/menu.pdf'}}]},
      scrape,
    });
    const response = await handler(new Request('http://localhost/api/import/job-1'), context);
    expect(response.status).toBe(200);
    expect(scrape).toHaveBeenCalledWith({
      url: 'https://restaurant.example/menu.pdf', formats: ['markdown'],
      parsers: [{type: 'pdf', mode: 'auto'}],
    });
    expect(generateStructured).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('# PDF menu'),
    }));
  });

  it('marks provider failure and rejects malformed extraction loudly', async () => {
    const failed = statusHandler({crawl: {status: 'failed'}});
    const failedResponse = await failed.handler(new Request('http://localhost/api/import/job-1'), context);
    expect(failedResponse.status).toBe(200);
    expect(failed.repo.updateImportJob).toHaveBeenCalledWith('job-1', expect.objectContaining({status: 'failed'}));

    const malformed = statusHandler({
      crawl: {status: 'completed', data: [{markdown: 'menu'}]},
      extracted: {menu: [{name: '', priceCents: -1}], menuComplete: false, hours: [], faqs: []},
    });
    const malformedResponse = await malformed.handler(new Request('http://localhost/api/import/job-1'), context);
    expect(malformedResponse.status).toBe(502);
    await expect(malformedResponse.json()).resolves.toEqual({
      error: {code: 'SCHEMA_MISMATCH', message: 'Import extraction did not match the expected schema'},
    });
    expect(malformed.repo.saveImportReviewRows).not.toHaveBeenCalled();
  });

  it('hides jobs owned by another organization and avoids duplicate in-flight extraction', async () => {
    const foreignRepo = repository();
    foreignRepo.getImportJob.mockResolvedValueOnce({id: 'job-1', organization_id: 'other'});
    const foreign = statusHandler({repo: foreignRepo});
    expect((await foreign.handler(new Request('http://localhost/api/import/job-1'), context)).status).toBe(404);

    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const concurrent = statusHandler({crawl: {status: 'completed', data: [{markdown: 'menu'}]}});
    concurrent.generateStructured.mockImplementationOnce(async () => {
      await gate;
      return {response: {}, json: {menu: [], hours: [], faqs: []}};
    });
    const first = concurrent.handler(new Request('http://localhost/api/import/job-1'), context);
    await vi.waitFor(() => expect(concurrent.generateStructured).toHaveBeenCalledTimes(1));
    const duplicate = await concurrent.handler(new Request('http://localhost/api/import/job-1'), context);
    expect(duplicate.status).toBe(202);
    finish();
    await first;
    expect(concurrent.generateStructured).toHaveBeenCalledTimes(1);
  });
});
