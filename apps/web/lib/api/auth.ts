import {createServerAuthProvider} from '@/lib/auth/server';
import type {AppRole} from '@/lib/auth/permissions';
import type {AuthUser} from '@/lib/auth/types';

import {apiError} from './errors';

export type AuthorizedRequest =
  | {ok: true; user: AuthUser}
  | {ok: false; response: Response};

type GetUser = () => Promise<AuthUser | null>;

async function defaultGetUser(): Promise<AuthUser | null> {
  return (await createServerAuthProvider()).getUser();
}

export async function authorizeApiRequest(
  roles: readonly AppRole[],
  getUser: GetUser = defaultGetUser,
): Promise<AuthorizedRequest> {
  const user = await getUser();
  if (!user) {
    return {ok: false, response: apiError('UNAUTHORIZED', 'Authentication required', 401)};
  }
  if (!roles.includes(user.role)) {
    return {ok: false, response: apiError('FORBIDDEN', 'Insufficient permissions', 403)};
  }
  return {ok: true, user};
}
