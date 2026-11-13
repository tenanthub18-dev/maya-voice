'use server';

import {headers} from 'next/headers';
import {redirect} from 'next/navigation';

import {assertDemoLoginAllowed, isMockAuth, sanitizeReturnTo} from '@/lib/auth';
import {createServerAuthProvider} from '@/lib/auth/server';
import {assertServerActionOrigin, assertStrictFormData} from '@/lib/security/actions';

function requiredText(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`);
  return value.trim();
}

async function appOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/u, '');
  if (!isMockAuth()) throw new Error('NEXT_PUBLIC_APP_URL is required in live mode');
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') ?? 'localhost:3000';
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'http';
  return `${protocol}://${host}`;
}

export async function authenticateAction(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['intent', 'email', 'password', 'returnTo']);
  await assertServerActionOrigin();
  const provider = await createServerAuthProvider();
  const intent = requiredText(formData, 'intent');
  const returnTo = sanitizeReturnTo(formData.get('returnTo')?.toString());
  const origin = await appOrigin();
  const callback = `${origin}/auth/callback?next=${encodeURIComponent(returnTo)}`;

  if (intent === 'demo') {
    assertDemoLoginAllowed();
    await provider.signInAsDemo('owner');
    redirect(returnTo);
  }
  if (intent === 'google') {
    const result = await provider.signInWithGoogle({redirectTo: callback});
    if (!result.redirectTo) throw new Error('Google sign-in did not return a redirect URL');
    redirect(result.redirectTo);
  }
  const email = requiredText(formData, 'email');
  if (intent === 'magic') {
    await provider.sendMagicLink({email, emailRedirectTo: callback});
    redirect(`/login?sent=1&returnTo=${encodeURIComponent(returnTo)}`);
  }
  const password = requiredText(formData, 'password');
  if (intent === 'signup') {
    await provider.signUp({email, password, emailRedirectTo: callback});
    redirect('/login?verify=1');
  }
  if (intent !== 'password') throw new Error('Unsupported authentication method');
  await provider.signInWithPassword({email, password});
  redirect(returnTo);
}

export async function demoLoginAction(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['intent', 'returnTo']);
  await assertServerActionOrigin();
  assertDemoLoginAllowed();
  const provider = await createServerAuthProvider();
  await provider.signInAsDemo('owner');
  redirect(sanitizeReturnTo(formData.get('returnTo')?.toString()));
}
