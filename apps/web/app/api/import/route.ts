import {createImportPostHandler} from './_lib/workflow';

let defaultHandler: Promise<ReturnType<typeof createImportPostHandler>> | undefined;

export async function POST(request: Request): Promise<Response> {
  defaultHandler ??= import('./_lib/defaults').then(({defaultImportPostDependencies}) =>
    createImportPostHandler(defaultImportPostDependencies()));
  return (await defaultHandler)(request);
}
