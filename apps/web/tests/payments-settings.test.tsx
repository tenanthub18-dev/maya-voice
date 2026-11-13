// @vitest-environment jsdom

import {cleanup, render, screen} from '@testing-library/react';
import {NextIntlClientProvider} from 'next-intl';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {PaymentSettingsCard} from '@/components/payment-settings-card';
import messages from '@/messages/en.json';
import messagesFr from '@/messages/fr.json';

afterEach(cleanup);

describe('PaymentSettingsCard', () => {
  it.each([
    ['en', messages, 'Connect Stripe', 'Not connected'],
    ['fr', messagesFr, 'Connecter Stripe', 'Non connecté'],
  ] as const)('renders localized not-connected state for owners in %s', async (locale, localizedMessages, button, status) => {
    const request = vi.fn(async () => Response.json({status: 'not_connected'}));
    render(<NextIntlClientProvider locale={locale} messages={localizedMessages}>
      <PaymentSettingsCard request={request}/>
    </NextIntlClientProvider>);

    expect(await screen.findByText(status)).toBeTruthy();
    expect(screen.getByRole('button', {name: button})).toBeTruthy();
  });

  it('shows ready state and a disconnect action', async () => {
    const request = vi.fn(async () => Response.json({status: 'ready', connectedAccountId: 'acct_123'}));
    render(<NextIntlClientProvider locale="en" messages={messages}>
      <PaymentSettingsCard request={request}/>
    </NextIntlClientProvider>);

    expect(await screen.findByText('Ready')).toBeTruthy();
    expect(screen.getByRole('button', {name: 'Disconnect'})).toBeTruthy();
  });
});
