import {dispatchMockRequest} from '../../../_mock/_lib/dispatcher';

export const POST = (request: Request) => dispatchMockRequest(request, 'resend');
