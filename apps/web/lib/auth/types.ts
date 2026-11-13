import type {AppRole} from './permissions';

export interface AuthUser {
  id: string;
  email: string;
  role: AppRole;
  organizationId: string | null;
}

export interface AuthResult {
  user: AuthUser | null;
  redirectTo?: string;
}

export interface AuthProvider {
  getUser(): Promise<AuthUser | null>;
  signUp(input: {email: string; password: string; emailRedirectTo: string}): Promise<AuthResult>;
  signInWithPassword(input: {email: string; password: string}): Promise<AuthResult>;
  signInWithGoogle(input: {redirectTo: string}): Promise<AuthResult>;
  sendMagicLink(input: {email: string; emailRedirectTo: string}): Promise<void>;
  exchangeCodeForSession(code: string): Promise<AuthResult>;
  signInAsDemo(role: 'owner' | 'staff'): Promise<AuthResult>;
  signOut(): Promise<void>;
}
