import type {SendEmailInput} from '@/lib/integrations/resend';
import {renderNotification, type NotificationLocale} from './templates';

type ImmediateNotificationType = 'message_taken' | 'flagged_call' | 'low_balance' | 'payment_failed';

export async function sendOwnerNotification(input: {
  type: ImmediateNotificationType;
  locale: NotificationLocale;
  restaurantName: string;
  detail: string;
  recipient: string;
  from: string;
  eventId: string;
}, sendEmail: (email: SendEmailInput, options: {idempotencyKey: string}) => Promise<{id: string}>): Promise<{id: string}> {
  const template = renderNotification(input.locale, input.type, input);
  return sendEmail({
    from: input.from,
    to: input.recipient,
    subject: template.subject,
    text: template.text,
    html: template.html,
    tags: [{name: 'notification', value: input.type}],
  }, {idempotencyKey: `notification:${input.type}:${input.eventId}`});
}
