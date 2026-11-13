import {numberRouteDependencies} from '../_default';
import {createReleaseNumberHandler} from '../_lib';

export const POST = (request: Request) =>
  createReleaseNumberHandler(numberRouteDependencies())(request);
