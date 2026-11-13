import {describe, expect, it} from 'vitest';

import {
  InMemoryInvitationRepository,
  acceptInvitation,
  createInvitation,
  type InvitationEmailSender,
} from '@/lib/auth/invitations';

class RecordingEmailSender implements InvitationEmailSender {
  readonly messages: Array<{email: string; acceptUrl: string}> = [];

  async sendInvitation(message: {email: string; acceptUrl: string}): Promise<void> {
    this.messages.push(message);
  }
}

describe('organization invitations', () => {
  it('stores only a token hash and sends the opaque token in the acceptance URL', async () => {
    const repository = new InMemoryInvitationRepository();
    const email = new RecordingEmailSender();
    const invitation = await createInvitation({
      repository,
      email,
      organizationId: 'org-1',
      inviterUserId: 'owner-1',
      inviteeEmail: 'Staff@Example.com',
      role: 'staff',
      appOrigin: 'https://app.example.com',
      now: new Date('2026-10-27T12:00:00Z'),
      tokenBytes: Buffer.alloc(32, 7),
    });

    expect(invitation.tokenHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(repository.records[0]).not.toHaveProperty('token');
    expect(repository.records[0]?.email).toBe('staff@example.com');
    expect(email.messages[0]?.acceptUrl).toMatch(/^https:\/\/app\.example\.com\/invite\/accept\?token=/u);
    expect(email.messages[0]?.acceptUrl).not.toContain(invitation.tokenHash);
  });

  it('rejects expired invitations', async () => {
    const repository = new InMemoryInvitationRepository();
    const email = new RecordingEmailSender();
    const invitation = await createInvitation({
      repository,
      email,
      organizationId: 'org-1',
      inviterUserId: 'owner-1',
      inviteeEmail: 'staff@example.com',
      role: 'staff',
      appOrigin: 'https://app.example.com',
      now: new Date('2026-10-20T12:00:00Z'),
      tokenBytes: Buffer.alloc(32, 8),
    });

    await expect(acceptInvitation({
      repository,
      token: invitation.token,
      userId: 'staff-1',
      userEmail: 'staff@example.com',
      now: new Date('2026-10-27T12:00:01Z'),
    })).rejects.toThrow(/expired/i);
  });

  it('accepts once for the invited email and then rejects token reuse', async () => {
    const repository = new InMemoryInvitationRepository();
    const invitation = await createInvitation({
      repository,
      email: new RecordingEmailSender(),
      organizationId: 'org-1',
      inviterUserId: 'owner-1',
      inviteeEmail: 'staff@example.com',
      role: 'staff',
      appOrigin: 'https://app.example.com',
      now: new Date('2026-10-27T12:00:00Z'),
      tokenBytes: Buffer.alloc(32, 9),
    });

    await expect(acceptInvitation({
      repository,
      token: invitation.token,
      userId: 'staff-1',
      userEmail: 'staff@example.com',
      now: new Date('2026-10-27T12:01:00Z'),
    })).resolves.toMatchObject({organizationId: 'org-1', role: 'staff'});
    await expect(acceptInvitation({
      repository,
      token: invitation.token,
      userId: 'staff-1',
      userEmail: 'staff@example.com',
      now: new Date('2026-10-27T12:02:00Z'),
    })).rejects.toThrow(/invalid|used/i);
  });

  it('rejects a wrong token and a different signed-in email', async () => {
    const repository = new InMemoryInvitationRepository();
    const invitation = await createInvitation({
      repository,
      email: new RecordingEmailSender(),
      organizationId: 'org-1',
      inviterUserId: 'owner-1',
      inviteeEmail: 'staff@example.com',
      role: 'staff',
      appOrigin: 'https://app.example.com',
      now: new Date('2026-10-27T12:00:00Z'),
      tokenBytes: Buffer.alloc(32, 10),
    });

    await expect(acceptInvitation({
      repository,
      token: 'wrong-token',
      userId: 'staff-1',
      userEmail: 'staff@example.com',
      now: new Date('2026-10-27T12:01:00Z'),
    })).rejects.toThrow(/invalid/i);
    await expect(acceptInvitation({
      repository,
      token: invitation.token,
      userId: 'other-1',
      userEmail: 'other@example.com',
      now: new Date('2026-10-27T12:01:00Z'),
    })).rejects.toThrow(/email/i);
  });
});
