export type NotificationLocale = 'en' | 'fr';
export type NotificationType = 'message_taken' | 'flagged_call' | 'low_balance' | 'payment_failed' | 'daily_digest';

interface AlertData {restaurantName: string; detail: string}
interface DigestData {restaurantName: string; calls: number; bookings: number; orders: number; messages: number; flagged: number}
export type NotificationData = AlertData | DigestData;

export interface NotificationTemplate {subject: string; text: string; html: string}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function asDigest(data: NotificationData): DigestData {
  if (!('calls' in data)) throw new Error('Daily digest data is incomplete');
  return data;
}

function asAlert(data: NotificationData): AlertData {
  if (!('detail' in data)) throw new Error('Alert data is incomplete');
  return data;
}

export function renderNotification(locale: NotificationLocale, type: NotificationType, data: NotificationData): NotificationTemplate {
  if (type === 'daily_digest') {
    const raw = asDigest(data);
    const value = {...raw, restaurantName: emailHeaderText(raw.restaurantName)};
    const subject = locale === 'fr' ? `Résumé quotidien — ${value.restaurantName}` : `${value.restaurantName} daily digest`;
    const text = locale === 'fr'
      ? `${value.calls} appels · ${value.bookings} réservations · ${value.orders} commandes · ${value.messages} messages · ${value.flagged} appels signalés`
      : `${value.calls} calls · ${value.bookings} bookings · ${value.orders} orders · ${value.messages} messages · ${value.flagged} flagged calls`;
    return {subject, text, html: `<h1>${escapeHtml(subject)}</h1><p>${escapeHtml(text)}</p>`};
  }

  const raw = asAlert(data);
  const value = {
    restaurantName: emailHeaderText(raw.restaurantName),
    detail: stripBidiControls(raw.detail),
  };
  const labels = locale === 'fr'
    ? {message_taken: 'Nouveau message', flagged_call: 'Appel signalé', low_balance: "Alerte d’utilisation", payment_failed: 'Paiement échoué'}
    : {message_taken: 'New message taken', flagged_call: 'Flagged call', low_balance: 'Usage alert', payment_failed: 'Payment failed'};
  const subject = `${labels[type]} — ${value.restaurantName}`;
  const text = `${value.restaurantName}: ${value.detail}`;
  return {subject, text, html: `<h1>${escapeHtml(subject)}</h1><p>${escapeHtml(text)}</p>`};
}
import {emailHeaderText, stripBidiControls} from '@/lib/security/text';
