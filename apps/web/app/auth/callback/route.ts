import {NextResponse, type NextRequest} from 'next/server';

import {sanitizeReturnTo} from '@/lib/auth';
import {createServerAuthProvider} from '@/lib/auth/server';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code');
  if (!code) return NextResponse.redirect(new URL('/login?error=missing_code', request.url));
  try {
    await (await createServerAuthProvider()).exchangeCodeForSession(code);
  } catch {
    return NextResponse.redirect(new URL('/login?error=callback_failed', request.url));
  }
  return NextResponse.redirect(new URL(sanitizeReturnTo(request.nextUrl.searchParams.get('next')), request.url));
}
