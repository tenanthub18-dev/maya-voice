'use server';

import {requireActionCapability} from '@/lib/auth/guards';
import {getDataSource} from '@/lib/data';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import type {NotificationPreferences} from '@/lib/data/types';
import {hasMandatoryRecordingDisclosure} from '@/lib/compliance/recording';
import {assertStrictFormData} from '@/lib/security/actions';
import {validateRetentionDays} from '@/lib/settings';
import {getCurrentRestaurant} from '@/lib/restaurant';

export async function saveNotificationPreferences(form: FormData): Promise<void> {
  assertStrictFormData(form, ['messageTaken', 'missedTransfer', 'flaggedCall', 'lowBalance', 'dailyDigest']);
  await requireActionCapability('editOperations');
  const keys = ['messageTaken', 'missedTransfer', 'flaggedCall', 'lowBalance', 'dailyDigest'] as const satisfies readonly (keyof NotificationPreferences)[];
  const preferences = Object.fromEntries(keys.map((key) => [key, form.has(key)])) as unknown as NotificationPreferences;
  await getDataSource().updateNotificationPreferences(preferences);
  await invalidateAfterWrite();
}

export async function saveLegalSettings(form: FormData): Promise<void> {
  assertStrictFormData(form, ['recordingNotice', 'recordingEnabled', 'transcriptEnabled', 'recordingRetentionDays', 'transcriptRetentionDays']);
  await requireActionCapability('editOperations');
  const recordingNotice = String(form.get('recordingNotice') ?? '').trim();
  const source = getDataSource();
  const recordingRetention = validateRetentionDays(String(form.get('recordingRetentionDays') ?? ''));
  const transcriptRetention = validateRetentionDays(String(form.get('transcriptRetentionDays') ?? ''));
  if (!recordingRetention.valid || !transcriptRetention.valid) throw new Error('Retention must be an integer from 30 to 365 days');
  const restaurant = await getCurrentRestaurant();
  if (!hasMandatoryRecordingDisclosure(recordingNotice, restaurant.province)) throw new Error('Recording notice must retain the mandatory bilingual disclosure');
  await source.updateLegalSettings({
    recordingNotice,
    recordingEnabled: form.has('recordingEnabled'),
    transcriptEnabled: form.has('transcriptEnabled'),
    recordingRetentionDays: recordingRetention.days!,
    transcriptRetentionDays: transcriptRetention.days!,
  });
  await invalidateAfterWrite();
}
