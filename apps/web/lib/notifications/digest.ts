import type {SendEmailInput} from '@/lib/integrations/resend';
import {renderNotification, type NotificationLocale} from './templates';

export interface DailyDigestRecipient {
  id: string;
  email: string;
  locale: NotificationLocale;
  restaurantName: string;
  calls: number;
  bookings: number;
  orders: number;
  messages: number;
  flagged: number;
}

export interface DailyDigestRepository {
  listDailyDigestRecipients(day: string): Promise<DailyDigestRecipient[]>;
  markDigestDelivered(id: string, day: string): Promise<void>;
}

export async function runDailyDigest(input: {
  day: string;
  from: string;
  repository: DailyDigestRepository;
  sendEmail(email: SendEmailInput, options: {idempotencyKey: string}): Promise<{id: string}>;
}): Promise<{sent: number; failed: number}> {
  const recipients = await input.repository.listDailyDigestRecipients(input.day);
  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      const template = renderNotification(recipient.locale, 'daily_digest', recipient);
      await input.sendEmail({
        from: input.from,
        to: recipient.email,
        subject: template.subject,
        text: template.text,
        html: template.html,
        tags: [{name: 'notification', value: 'daily_digest'}],
      }, {idempotencyKey: `daily-digest:${recipient.id}:${input.day}`});
      await input.repository.markDigestDelivered(recipient.id, input.day);
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return {sent, failed};
}
