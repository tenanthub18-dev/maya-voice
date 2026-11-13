import {billingRouteDependencies} from '../_default';
import {createPortalHandler} from '../_lib';

export const POST = (request: Request) => createPortalHandler(billingRouteDependencies())(request);
