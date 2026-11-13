import {createServer} from 'node:http';

import {mockFetch} from '../app/api/_mock/_lib/dispatcher';

async function e2eProviderFetch(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.startsWith('/api/_mock/gemini/models/')) {
    // Gemini structured output is returned as JSON text inside a candidate part:
    // https://ai.google.dev/gemini-api/docs/structured-output
    return Response.json({
      candidates: [{
        content: {
          role: 'model',
          parts: [{text: JSON.stringify({menu: [], menuComplete: false, hours: [], faqs: []})}],
        },
        finishReason: 'STOP',
        index: 0,
      }],
    });
  }
  return mockFetch(request);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const port = Number(process.env.PLAYWRIGHT_MOCK_PORT);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error('PLAYWRIGHT_MOCK_PORT must be a positive integer');
  }

  const server = createServer(async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${port}`);
      const body: Buffer[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      const payload = Buffer.concat(body);
      const response = await e2eProviderFetch(new Request(url, {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(payload.length > 0 ? {body: payload} : {}),
      }));

      outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(error);
      outgoing.writeHead(500, {'content-type': 'application/json'});
      outgoing.end(JSON.stringify({error: 'mock_provider_failure'}));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return () => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
