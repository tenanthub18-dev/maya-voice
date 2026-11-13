'use server';

import {redirect} from 'next/navigation';

import {requireActionCapability, requireActionUser} from '@/lib/auth/guards';
import {acceptInvitation, createInvitation} from '@/lib/auth/invitations';
import {createInvitationEmailSender, createInvitationRepository} from '@/lib/auth/invitation-server';
import {assertStrictFormData} from '@/lib/security/actions';

function required(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value.trim();
}

export async function inviteMemberAction(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['organizationId', 'role', 'email']);
  const user = await requireActionCapability('inviteMembers');
  const organizationId = required(formData, 'organizationId');
  if (user.organizationId !== organizationId) throw new Error('Organization not found');
  const role = required(formData, 'role');
  if (role !== 'owner' && role !== 'staff') throw new Error('Invalid invitation role');
  const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  await createInvitation({
    repository: await createInvitationRepository(),
    email: createInvitationEmailSender(),
    organizationId,
    inviterUserId: user.id,
    inviteeEmail: required(formData, 'email'),
    role,
    appOrigin,
  });
  redirect('/settings?invited=1');
}

export async function acceptInvitationAction(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['token']);
  const user = await requireActionUser();
  await acceptInvitation({
    repository: await createInvitationRepository(),
    token: required(formData, 'token'),
    userId: user.id,
    userEmail: user.email,
  });
  redirect('/home');
}
