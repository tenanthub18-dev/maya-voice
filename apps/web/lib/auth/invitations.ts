import {createHash, randomBytes} from 'node:crypto';

export type OrganizationRole = 'owner' | 'staff';

export interface StoredInvitation {
  id: string;
  organizationId: string;
  inviterUserId: string;
  email: string;
  role: OrganizationRole;
  tokenHash: string;
  expiresAt: Date;
  acceptedAt: Date | null;
}

export interface AcceptedMembership {
  organizationId: string;
  userId: string;
  role: OrganizationRole;
}

export interface InvitationRepository {
  insert(invitation: Omit<StoredInvitation, 'id'>): Promise<StoredInvitation>;
  findByTokenHash(tokenHash: string): Promise<StoredInvitation | null>;
  accept(invitationId: string, membership: AcceptedMembership, acceptedAt: Date): Promise<AcceptedMembership>;
}

export interface InvitationEmailSender {
  sendInvitation(message: {email: string; acceptUrl: string}): Promise<void>;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class InMemoryInvitationRepository implements InvitationRepository {
  readonly records: StoredInvitation[] = [];
  readonly memberships: AcceptedMembership[] = [];

  async insert(invitation: Omit<StoredInvitation, 'id'>): Promise<StoredInvitation> {
    const stored = {...invitation, id: `invite-${this.records.length + 1}`};
    this.records.push(stored);
    return stored;
  }

  async findByTokenHash(tokenHash: string): Promise<StoredInvitation | null> {
    return this.records.find((record) => record.tokenHash === tokenHash) ?? null;
  }

  async accept(invitationId: string, membership: AcceptedMembership, acceptedAt: Date): Promise<AcceptedMembership> {
    const invitation = this.records.find((record) => record.id === invitationId);
    if (!invitation || invitation.acceptedAt) throw new Error('Invitation is invalid or already used');
    invitation.acceptedAt = acceptedAt;
    this.memberships.push(membership);
    return membership;
  }
}

export async function createInvitation(input: {
  repository: InvitationRepository;
  email: InvitationEmailSender;
  organizationId: string;
  inviterUserId: string;
  inviteeEmail: string;
  role: OrganizationRole;
  appOrigin: string;
  now?: Date;
  tokenBytes?: Uint8Array;
  expiresInMs?: number;
}): Promise<StoredInvitation & {token: string}> {
  const now = input.now ?? new Date();
  const token = Buffer.from(input.tokenBytes ?? randomBytes(32)).toString('base64url');
  const stored = await input.repository.insert({
    organizationId: input.organizationId,
    inviterUserId: input.inviterUserId,
    email: input.inviteeEmail.trim().toLowerCase(),
    role: input.role,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + (input.expiresInMs ?? 7 * 24 * 60 * 60 * 1000)),
    acceptedAt: null,
  });
  const acceptUrl = new URL('/invite/accept', input.appOrigin);
  acceptUrl.searchParams.set('token', token);
  await input.email.sendInvitation({email: stored.email, acceptUrl: acceptUrl.toString()});
  return {...stored, token};
}

export async function acceptInvitation(input: {
  repository: InvitationRepository;
  token: string;
  userId: string;
  userEmail: string;
  now?: Date;
}): Promise<AcceptedMembership> {
  const now = input.now ?? new Date();
  const invitation = await input.repository.findByTokenHash(hashToken(input.token));
  if (!invitation || invitation.acceptedAt) throw new Error('Invitation is invalid or already used');
  if (invitation.expiresAt.getTime() <= now.getTime()) throw new Error('Invitation has expired');
  if (invitation.email !== input.userEmail.trim().toLowerCase()) {
    throw new Error('Invitation email does not match the signed-in account');
  }
  return input.repository.accept(invitation.id, {
    organizationId: invitation.organizationId,
    userId: input.userId,
    role: invitation.role,
  }, now);
}
