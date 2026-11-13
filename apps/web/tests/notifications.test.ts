import {describe, expect, it, vi} from 'vitest';

import {createDigestCronHandler} from '@/app/api/cron/digest/_lib';
import {runDailyDigest} from '@/lib/notifications/digest';
import {renderNotification} from '@/lib/notifications/templates';
import {sendOwnerNotification} from '@/lib/notifications/sender';

const summary = {restaurantName: 'Harbour Table', calls: 14, bookings: 3, orders: 2, messages: 1, flagged: 2};

describe('notification templates', () => {
  it('renders the daily digest in English and Canadian French', () => {
    const en = renderNotification('en', 'daily_digest', summary);
    expect(en.subject).toBe('Harbour Table daily digest');
    expect(en.text).toContain('14 calls');
    expect(en.text).toContain('2 flagged calls');

    const fr = renderNotification('fr', 'daily_digest', summary);
    expect(fr.subject).toBe('Résumé quotidien — Harbour Table');
    expect(fr.text).toContain('14 appels');
    expect(fr.text).toContain('2 appels signalés');
  });

  it('renders message, flagged-call, and low-balance alerts without leaking unescaped HTML', () => {
    expect(renderNotification('en', 'message_taken', {restaurantName: '<Dining>', detail: 'Call back'}).html).toContain('&lt;Dining&gt;');
    expect(renderNotification('fr', 'flagged_call', {restaurantName: 'Bistro', detail: 'Vérifier'}).subject).toContain('Appel signalé');
    expect(renderNotification('en', 'low_balance', {restaurantName: 'Cafe', detail: '80%'}).subject).toContain('Usage alert');
  });

  it('renders failed-payment alerts in English and French', () => {
    expect(renderNotification('en', 'payment_failed', {restaurantName: 'Cafe', detail: 'Update payment'}).subject).toContain('Payment failed');
    expect(renderNotification('fr', 'payment_failed', {restaurantName: 'Café', detail: 'Mettre à jour'}).subject).toContain('Paiement échoué');
  });
});

describe('daily digest job', () => {
  it('sends enabled recipients through Resend and marks successful deliveries', async () => {
    const markDelivered = vi.fn().mockResolvedValue(undefined);
    const sendEmail = vi.fn().mockResolvedValue({id: 'email-1'});
    const result = await runDailyDigest({
      day: '2026-10-27',
      from: 'Receptionist <alerts@example.com>',
      repository: {
        listDailyDigestRecipients: async () => [{id: 'pref-1', email: 'owner@example.com', locale: 'fr' as const, ...summary}],
        markDigestDelivered: markDelivered,
      },
      sendEmail,
    });
    expect(result).toEqual({sent: 1, failed: 0});
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({to: 'owner@example.com', subject: 'Résumé quotidien — Harbour Table'}), {idempotencyKey: 'daily-digest:pref-1:2026-10-27'});
    expect(markDelivered).toHaveBeenCalledWith('pref-1', '2026-10-27');
  });
});

describe('immediate notification delivery', () => {
  it('sends message, flagged-call, and low-balance alerts through the Resend boundary', async () => {
    const sendEmail = vi.fn().mockResolvedValue({id: 'email-1'});
    for (const type of ['message_taken', 'flagged_call', 'low_balance'] as const) {
      await sendOwnerNotification({
        type, locale: 'en', restaurantName: 'Harbour Table', detail: type,
        recipient: 'owner@example.com', from: 'Alerts <alerts@example.com>', eventId: `event-${type}`,
      }, sendEmail);
    }
    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(sendEmail).toHaveBeenNthCalledWith(1, expect.objectContaining({to: 'owner@example.com'}), {idempotencyKey: 'notification:message_taken:event-message_taken'});
  });
});

describe('digest cron route', () => {
  it('rejects a missing secret and runs the job with a valid bearer secret', async () => {
    const run = vi.fn().mockResolvedValue({sent: 2, failed: 0});
    const handler = createDigestCronHandler({secret: 'cron-secret', run});
    expect((await handler(new Request('https://app.example/api/cron/digest'))).status).toBe(401);
    const response = await handler(new Request('https://app.example/api/cron/digest', {headers: {authorization: 'Bearer cron-secret'}}));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({sent: 2, failed: 0});
    expect(run).toHaveBeenCalledTimes(1);
  });
});
