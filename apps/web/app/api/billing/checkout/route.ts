import {billingRouteDependencies} from '../_default';
import {createCheckoutHandler} from '../_lib';

export const POST = (request: Request) => createCheckoutHandler(billingRouteDependencies())(request);
