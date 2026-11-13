import {getIntegrationsMode, getProviderBaseUrl, type Environment} from '@/lib/integrations/mode';
import {createResendClient} from '@/lib/integrations/resend';
import {getProductName} from '@/lib/brand';

import {InMemoryInvitationRepository, type InvitationEmailSender, type InvitationRepository} from './invitations';
import {SupabaseInvitationRepository} from './supabase/invitations';
import {createAuthenticatedSupabaseClient} from './supabase/server-client';

const mockRepository = new InMemoryInvitationRepository();

export async function createInvitationRepository(env: Environment = process.env): Promise<InvitationRepository> {
  if (getIntegrationsMode(env) === 'mock') return mockRepository;
  return new SupabaseInvitationRepository(await createAuthenticatedSupabaseClient());
}

export function createInvitationEmailSender(env: Environment = process.env): InvitationEmailSender {
  const mock = getIntegrationsMode(env) === 'mock';
  const productName = getProductName('en');
  const apiKey = mock ? 'mock-mode-no-provider-key' : env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY is required in live mode');
  const from = env.RESEND_FROM_EMAIL ?? (mock ? `${productName} <onboarding@resend.dev>` : undefined);
  if (!from) throw new Error('RESEND_FROM_EMAIL is required in live mode');
  const client = createResendClient({apiKey, baseUrl: getProviderBaseUrl('resend', env)});
  return {
    async sendInvitation({email, acceptUrl}) {
      await client.sendEmail({
        from,
        to: email,
        subject: `Join your restaurant on ${productName}`,
        text: `You were invited to join your restaurant workspace. Accept the invitation: ${acceptUrl}`,
      }, {idempotencyKey: `organization-invite-${Buffer.from(acceptUrl).toString('base64url').slice(-128)}`});
    },
  };
}
