import {createImportStatusHandler} from '../_lib/workflow';

let defaultHandler: Promise<ReturnType<typeof createImportStatusHandler>> | undefined;

export async function GET(
  request: Request,
  context: {params: Promise<{id: string}>},
): Promise<Response> {
  defaultHandler ??= import('../_lib/defaults').then(({defaultImportStatusDependencies}) =>
    createImportStatusHandler(defaultImportStatusDependencies()));
  return (await defaultHandler)(request, context);
}
