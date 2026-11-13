import {numberRouteDependencies} from '../_default';
import {createSearchNumbersHandler} from '../_lib';

export const POST = (request: Request) =>
  createSearchNumbersHandler(numberRouteDependencies())(request);
