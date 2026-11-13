import {describe, expect, it, vi} from 'vitest';

import {createFirecrawlClient} from '@/lib/integrations/firecrawl';
import {ApiError} from '@/lib/integrations/http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

describe('FirecrawlClient', () => {
  it('calls every v2 operation and validates its response contract', async () => {
    const responses = [
      {success: true, data: {markdown: '# Menu', metadata: {statusCode: 200}}},
      {success: true, id: 'crawl-1', url: 'https://api.firecrawl.dev/v2/crawl/crawl-1'},
      {status: 'completed', total: 1, completed: 1, creditsUsed: 1, data: []},
      {success: true, links: [{url: 'https://restaurant.example/menu'}]},
      {success: true, id: 'extract-1', invalidURLs: []},
      {success: true, data: {name: 'Cafe'}, status: 'completed'},
    ];
    const fetch = vi.fn(async () => jsonResponse(responses.shift()));
    const client = createFirecrawlClient({baseUrl: 'https://api.firecrawl.dev/v2', apiKey: 'test', fetch});

    await expect(client.scrape({url: 'https://restaurant.example'})).resolves.toMatchObject({success: true});
    await expect(client.startCrawl({url: 'https://restaurant.example'})).resolves.toMatchObject({id: 'crawl-1'});
    await expect(client.getCrawl('crawl-1')).resolves.toMatchObject({status: 'completed'});
    await expect(client.map({url: 'https://restaurant.example'})).resolves.toMatchObject({links: [{url: 'https://restaurant.example/menu'}]});
    await expect(client.startExtract({urls: ['https://restaurant.example']})).resolves.toMatchObject({id: 'extract-1'});
    await expect(client.getExtract('extract-1')).resolves.toMatchObject({status: 'completed'});

    expect((fetch.mock.calls as unknown[][]).map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/v2/scrape', '/v2/crawl', '/v2/crawl/crawl-1', '/v2/map', '/v2/extract', '/v2/extract/extract-1',
    ]);
  });

  it('polls until terminal and rejects when the polling deadline expires', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({status: 'scraping', total: 2, completed: 1, creditsUsed: 1, data: []}))
      .mockResolvedValueOnce(jsonResponse({status: 'completed', total: 2, completed: 2, creditsUsed: 2, data: []}));
    const client = createFirecrawlClient({baseUrl: 'https://mock.test/v2', apiKey: 'test', fetch, sleep: async () => {}});
    await expect(client.pollCrawl('crawl-1', {timeoutMs: 100, intervalMs: 1})).resolves.toMatchObject({status: 'completed'});

    const neverDoneFetch = vi.fn(async () =>
      jsonResponse({success: true, data: [], status: 'processing'}),
    );
    const neverDone = createFirecrawlClient({
      baseUrl: 'https://mock.test/v2', apiKey: 'test',
      fetch: neverDoneFetch,
      sleep: async () => {}, now: (() => { let n = 0; return () => (n += 10); })(),
    });
    await expect(neverDone.pollExtract('extract-1', {timeoutMs: 15, intervalMs: 1})).rejects.toThrow('polling timed out');
    expect(neverDoneFetch).toHaveBeenCalledTimes(1);
  });

  it('fails loudly on a schema mismatch', async () => {
    const client = createFirecrawlClient({baseUrl: 'https://mock.test/v2', apiKey: 'test', fetch: async () => jsonResponse({success: 'yes'})});
    await expect(client.scrape({url: 'https://restaurant.example'})).rejects.toThrow(/invalid input/i);
  });

  it('preserves provider errors, retries transient GETs, and times out', async () => {
    const errorClient = createFirecrawlClient({baseUrl: 'https://mock.test/v2', apiKey: 'test', fetch: async () => jsonResponse({success: false, error: 'denied', code: 'blocked'}, 403)});
    const error = await errorClient.getCrawl('crawl-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({status: 403, body: {success: false, error: 'denied', code: 'blocked'}});

    let attempts = 0;
    const retryClient = createFirecrawlClient({
      baseUrl: 'https://mock.test/v2', apiKey: 'test',
      fetch: async () => (++attempts === 1 ? jsonResponse({error: 'busy'}, 503) : jsonResponse({status: 'completed', data: []})),
      request: {sleep: async () => {}, random: () => 0},
    });
    await expect(retryClient.getCrawl('crawl-1')).resolves.toMatchObject({status: 'completed'});
    expect(attempts).toBe(2);

    const timeoutClient = createFirecrawlClient({
      baseUrl: 'https://mock.test/v2', apiKey: 'test', request: {timeoutMs: 1},
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
    });
    await expect(timeoutClient.getCrawl('crawl-1')).rejects.toMatchObject({name: 'TimeoutError'});
  });
});
