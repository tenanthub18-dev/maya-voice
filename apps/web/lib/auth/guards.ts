import {createServerAuthProvider} from './server';
import {hasCapability, type Capability} from './permissions';
import type {AuthUser} from './types';
import {assertServerActionOrigin} from '@/lib/security/actions';

export class AuthorizationError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403) {
    super(status === 401 ? 'Authentication required' : 'Insufficient permissions');
    this.name = 'AuthorizationError';
    this.status = status;
  }
}

export async function requireUser(): Promise<AuthUser> {
  const user = await (await createServerAuthProvider()).getUser();
  if (!user) throw new AuthorizationError(401);
  return user;
}

export async function requireCapability(capability: Capability): Promise<AuthUser> {
  const user = await requireUser();
  if (!hasCapability(user.role, capability)) throw new AuthorizationError(403);
  return user;
}

export async function requireActionUser(): Promise<AuthUser> {
  await assertServerActionOrigin();
  return requireUser();
}

export async function requireActionCapability(capability: Capability): Promise<AuthUser> {
  await assertServerActionOrigin();
  return requireCapability(capability);
}

export async function authorizeRouteHandler(capability: Capability): Promise<AuthUser | Response> {
  try {
    return await requireCapability(capability);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return Response.json({error: error.message}, {status: error.status});
    }
    throw error;
  }
}
