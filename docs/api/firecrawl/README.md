# Firecrawl API reference (as of 2026-10-27)

**Current version: v2.** Base URL `https://api.firecrawl.dev/v2`; all docs examples use `/v2/` (source: https://docs.firecrawl.dev/introduction). That v1 is deprecated is **UNVERIFIED** (docs never mention v1). Auth for all: `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`.

Note: the `firecrawl` MCP server failed to connect this session; only docs were read. Several pages gave no literal response examples; fixtures say so in `_note`.

## POST /v2/scrape
Source: https://docs.firecrawl.dev/api-reference/endpoint/scrape , https://docs.firecrawl.dev/features/scrape
- Body: `url` (req); `formats` (default markdown; items string or object); `onlyMainContent` (true); `maxAge` ms (default 172800000); `waitFor` (<=60000); `timeout` (1000-300000, default 60000); `proxy` basic|enhanced|auto (auto); `location`; `actions`; `parsers` (default ["pdf","image"]).
- JSON extraction: `formats:[{"type":"json","prompt":"...","schema":{JSON Schema}}]`; schema and prompt both optional; result in `data.json`. Fixture `scrape.request.json`.
- PDF: detected from URL; `parsers:[{"type":"pdf","mode":"fast|auto|ocr","maxPages":1-10000,"pages":bool,"blocks":bool,"pageMarkers":bool}]`; `parsers:[]` returns base64 for flat 1 credit. Local files: use `/parse` (not fetched). Fixture `pdf-menu.scrape.request.json`.
- Success: `{success:true, data:{markdown, json, metadata{title,sourceURL,url,statusCode,...}}}` (derived; `scrape.response.json`). `metadata.statusCode` = target page status, distinct from HTTP status.
- Errors: body `{success:false, error, code?}`. 400, 402 `insufficient_credits`, 403 (`SCRAPE_PROMPT_INJECTION_DETECTED`), 404 (`SCRAPE_NO_CACHED_DATA`), 409 (`duplicate_request`,`request_in_flight`), 429, 500 `UNKNOWN_ERROR`, 503.

## POST /v2/crawl (start) / GET /v2/crawl/{id} (poll)
Sources: https://docs.firecrawl.dev/api-reference/endpoint/crawl-post , .../crawl-get , https://docs.firecrawl.dev/features/crawl
- Body: `url` (req), `prompt`, `includePaths`, `excludePaths` (regex on pathname), `maxDiscoveryDepth`, `sitemap` skip|include|only, `limit` (default 10000), `crawlEntireDomain`, `allowExternalLinks`, `allowSubdomains`, `delay`, `maxConcurrency`, `webhook{url,headers,metadata,events[started,page,completed,failed]}`, `scrapeOptions{...}`, `zeroDataRetention`.
- Start response: `{"success":true,"id":"123-456-789","url":"https://api.firecrawl.dev/v2/crawl/123-456-789"}`.
- Poll status values: `scraping`, `completed`, `failed`, `cancelled`. Fields: status,total,completed,creditsUsed,createdAt,completedAt,expiresAt,duration,next,data[]. `completed==total` does not prove all pages succeeded (failed pages excluded from total; use Get Crawl Errors endpoint, not fetched).
- Pagination: responses capped at 10MB; `next` URL (e.g. `...?skip=10`) given when truncated, but also appears on non-completed/terminal-failed responses. Poll until terminal, then follow `next` while present and last page had non-empty `data`.
- Results retrievable 24h after completion.
- Errors: 402 (also if remaining credits < `limit`), 429, 500, body `{"error":"..."}`; 400 for invalid regex.
- Webhooks: header `X-Firecrawl-Signature: sha256=<HMAC-SHA256 of raw body>` using webhook secret (account settings > Advanced); events crawl.started/page/completed/failed.

## POST /v2/map
Source: https://docs.firecrawl.dev/api-reference/endpoint/map
- Body: `url` (req), `search`, `sitemap` (include), `includeSubdomains` (true), `ignoreQueryParameters` (true), `ignoreCache`, `limit` (5000, max 100000), `timeout`, `location`.
- Response (schema-derived): `{success, links:[{url,title?,description?}]}`. Errors 402/429/500.

## POST /v2/extract / GET /v2/extract/{id}
Sources: https://docs.firecrawl.dev/api-reference/endpoint/extract , .../extract-get , https://docs.firecrawl.dev/features/extract
- **Status: docs call `/agent` the "successor to /extract"; /extract not stated deprecated, no shutdown date.** Prefer scrape `json` format for single known pages; consider /agent (not documented here) for new work.
- Body: `urls` (req, glob ok), `prompt`, `schema`, `enableWebSearch` (false), `ignoreSitemap`, `includeSubdomains` (true), `showSources`, `scrapeOptions`, `ignoreInvalidURLs` (true).
- Start response: `{success,id,invalidURLs}`. Poll `GET /v2/extract/{id}`: status `processing|completed|failed|cancelled`; fields success,data,status,expiresAt,tokensUsed (completed only). Results kept 24h. Errors listed: 400, 500 only.

## Credit costs
Source: https://docs.firecrawl.dev/billing
Scrape 1/page; crawl 1/page; map 1/call; JSON format +4/page; PDF +1/PDF page; PII redaction +4; ZDR +1; prompt-injection check +4; enhanced proxy +0; cached results still 1 credit. Charged only if a document returned (incl. 403/404 pages). Extract: credit = 15 tokens; per-request cost not stated.
Example: JSON-extract of a 3-page PDF menu = 1 + 4 + 3 = about 8 (our arithmetic from the table, UNVERIFIED for PDFs).

## Rate limits (per team, requests/min)
Source: https://docs.firecrawl.dev/rate-limits
| Plan | scrape | map | crawl | extract | crawl/status |
|---|---|---|---|---|---|
| Free | 10 | 10 | 2 | 2 | 500 |
| Hobby | 100 | 100 | 20 | 20 | 5,000 |
| Standard | 500 | 500 | 100 | 100 | 25,000 |
| Growth | 5,000 | 5,000 | 1,000 | 1,000 | 250,000 |
| Scale | 10,000 | 10,000 | 2,000 | 2,000 | 500,000 |
Concurrent browsers: Free 2, Hobby 5, Standard 25, Growth 50, Scale 100+. Queue timeout 48h; over-queue gives 429. Rate-limit headers: not documented.

## Restaurant extraction schema
OUR DESIGN, not from docs: `fixtures/OUR-DESIGN.restaurant-schema.json` (menu_items name/description/price/category, opening_hours, address, phone, faqs).

## Not confirmed
Literal response examples for scrape/map/extract-start; /errors page (404 at docs.firecrawl.dev/errors, so error catalog and 429 body unseen); /parse, /agent, Get Crawl Errors, cancel endpoints; whether v1 is formally deprecated; extract per-request credit cost; rate-limit headers; Pro/plan names beyond table; PDF credits when combined with JSON (arithmetic only).
