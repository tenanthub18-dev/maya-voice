import {numberRouteDependencies} from '../_default';
import {createBuyNumberHandler} from '../_lib';

export const POST = (request: Request) =>
  createBuyNumberHandler(numberRouteDependencies())(request);
