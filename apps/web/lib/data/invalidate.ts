'use server';

import {randomUUID} from 'node:crypto';

import {revalidatePath} from 'next/cache';
import {cookies} from 'next/headers';

export async function invalidateAfterWrite(): Promise<void> {
  // Next.js cache invalidation API: https://nextjs.org/docs/app/api-reference/functions/revalidatePath
  revalidatePath('/', 'layout');
  const cookieStore = await cookies();
  // Brief 032 consumes this revision nonce to refresh live client views after server writes.
  cookieStore.set({
    name: 'live-rev',
    value: randomUUID(),
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 86_400,
  });
}
