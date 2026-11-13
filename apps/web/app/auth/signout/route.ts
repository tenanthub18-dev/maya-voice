import {NextResponse, type NextRequest} from 'next/server';

import {createServerAuthProvider} from '@/lib/auth/server';
import {internalApiError} from '@/lib/api/errors';
import {validateMutationOrigin} from '@/lib/api/request';

export async function POST(request: NextRequest) {
  const originError = validateMutationOrigin(request);
  if (originError) return originError;
  try {
    await (await createServerAuthProvider()).signOut();
    return NextResponse.redirect(new URL('/', request.url), {status: 303});
  } catch {
    return internalApiError();
  }
}
