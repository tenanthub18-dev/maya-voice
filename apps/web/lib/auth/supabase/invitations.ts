import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';

import type {AcceptedMembership, InvitationRepository, StoredInvitation} from '../invitations';

const invitationRowSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  inviter_user_id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['owner', 'staff']),
  token_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  expires_at: z.iso.datetime(),
  accepted_at: z.iso.datetime().nullable(),
}).passthrough();
type InvitationRow = z.infer<typeof invitationRowSchema>;

function fromRow(row: InvitationRow): StoredInvitation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    inviterUserId: row.inviter_user_id,
    email: row.email,
    role: row.role,
    tokenHash: row.token_hash,
    expiresAt: new Date(row.expires_at),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at) : null,
  };
}

export class SupabaseInvitationRepository implements InvitationRepository {
  constructor(private readonly client: SupabaseClient) {}

  async insert(invitation: Omit<StoredInvitation, 'id'>): Promise<StoredInvitation> {
    const {data, error} = await this.client.from('organization_invitations').insert({
      organization_id: invitation.organizationId,
      inviter_user_id: invitation.inviterUserId,
      email: invitation.email,
      role: invitation.role,
      token_hash: invitation.tokenHash,
      expires_at: invitation.expiresAt.toISOString(),
    }).select('id,organization_id,inviter_user_id,email,role,token_hash,expires_at,accepted_at').single();
    if (error) throw error;
    return fromRow(invitationRowSchema.parse(data));
  }

  async findByTokenHash(tokenHash: string): Promise<StoredInvitation | null> {
    const {data, error} = await this.client.from('organization_invitations')
      .select('id,organization_id,inviter_user_id,email,role,token_hash,expires_at,accepted_at')
      .eq('token_hash', tokenHash).maybeSingle();
    if (error) throw error;
    return data ? fromRow(invitationRowSchema.parse(data)) : null;
  }

  async accept(invitationId: string, membership: AcceptedMembership): Promise<AcceptedMembership> {
    // The SECURITY DEFINER function atomically marks the token used and inserts membership.
    const {data, error} = await this.client.rpc('accept_organization_invitation', {p_invitation_id: invitationId});
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.organization_id !== membership.organizationId) throw new Error('Invitation acceptance returned an invalid membership');
    return {organizationId: row.organization_id, userId: membership.userId, role: row.role};
  }
}
