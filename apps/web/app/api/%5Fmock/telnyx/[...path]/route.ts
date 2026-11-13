import {dispatchMockRequest} from '../../../_mock/_lib/dispatcher';

const handle = (request: Request) => dispatchMockRequest(request, 'telnyx');

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
