import {numberRouteDependencies} from '../_default';
import {createAssignNumberHandler} from '../_lib';

export const POST = (request: Request) =>
  createAssignNumberHandler(numberRouteDependencies())(request);
