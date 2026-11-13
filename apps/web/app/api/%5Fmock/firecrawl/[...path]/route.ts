import {dispatchMockRequest} from '../../../_mock/_lib/dispatcher';

const handle = (request: Request) => dispatchMockRequest(request, 'firecrawl');

export const GET = handle;
export const POST = handle;
