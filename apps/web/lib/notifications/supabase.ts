import 'server-only';

import {createClient} from '@supabase/supabase-js';

import type {DailyDigestRecipient, DailyDigestRepository} from './digest';

function required(name: 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function createDailyDigestRepository(): DailyDigestRepository {
  // Service-role use is confined to this server job. https://supabase.com/docs/guides/api/api-keys
  const client = createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: {persistSession: false, autoRefreshToken: false, detectSessionInUrl: false},
  });
  return {
    async listDailyDigestRecipients(day) {
      const {data, error} = await client.rpc('daily_digest_candidates', {p_day: day});
      if (error) throw new Error(error.message);
      return (data ?? []).map((row: Record<string, unknown>): DailyDigestRecipient => ({
        id: String(row.id), email: String(row.email), locale: row.locale === 'fr' ? 'fr' : 'en',
        restaurantName: String(row.restaurant_name), calls: Number(row.calls), bookings: Number(row.bookings),
        orders: Number(row.orders), messages: Number(row.messages), flagged: Number(row.flagged),
      }));
    },
    async markDigestDelivered(id, day) {
      const {error} = await client.from('notification_preferences').update({last_digest_date: day}).eq('id', id);
      if (error) throw new Error(error.message);
    },
  };
}
