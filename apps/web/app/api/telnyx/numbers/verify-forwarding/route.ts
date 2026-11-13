import {numberRouteDependencies} from '../_default';
import {createVerifyForwardingHandler} from '../_lib';

export const POST = (request: Request) =>
  createVerifyForwardingHandler(numberRouteDependencies())(request);
