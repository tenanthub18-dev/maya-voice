import {createImportFileHandler} from '../_lib/workflow';

let defaultHandler: Promise<ReturnType<typeof createImportFileHandler>> | undefined;

export async function POST(request: Request): Promise<Response> {
  defaultHandler ??= import('../_lib/defaults').then(({defaultImportFileDependencies}) =>
    createImportFileHandler(defaultImportFileDependencies()));
  return (await defaultHandler)(request);
}
