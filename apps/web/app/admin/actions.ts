'use server';

import {redirect} from 'next/navigation';

import {requireActionCapability} from '@/lib/auth/guards';
import {getDataSource, type FeatureFlagKey} from '@/lib/data';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import {assertStrictFormData} from '@/lib/security/actions';

const MINIMUM_REASON_LENGTH = 10;

export async function startSupportSession(form: FormData): Promise<void> {
  assertStrictFormData(form, ['restaurantId', 'reason']);
  await requireActionCapability('accessAdmin');
  const restaurantId = required(form, 'restaurantId');
  const reason = supportReason(form);
  await getDataSource().startSupportSession(restaurantId, reason);
  redirect('/home');
}

export async function endSupportSession(form: FormData): Promise<void> {
  assertStrictFormData(form, ['sessionId']);
  await requireActionCapability('accessAdmin');
  await getDataSource().endSupportSession(required(form, 'sessionId'));
  redirect('/admin');
}

export async function toggleFeatureFlag(form: FormData): Promise<void> {
  assertStrictFormData(form, ['key', 'restaurantId', 'enabled']);
  await requireActionCapability('accessAdmin');
  const key = required(form, 'key');
  if (key !== 'diner_payments') throw new Error('FEATURE_FLAG_KEY_INVALID');
  const restaurantId = value(form, 'restaurantId') || null;
  await getDataSource().setFeatureFlag(key satisfies FeatureFlagKey, restaurantId, value(form, 'enabled') === 'true');
  await invalidateAfterWrite();
}

export async function togglePhoneKillSwitch(form: FormData): Promise<void> {
  assertStrictFormData(form, ['phoneNumberId', 'enabled', 'reason']);
  await requireActionCapability('accessAdmin');
  await getDataSource().setPhoneKillSwitch(
    required(form, 'phoneNumberId'),
    value(form, 'enabled') === 'true',
    supportReason(form),
  );
  await invalidateAfterWrite();
}

function supportReason(form: FormData): string {
  const reason = required(form, 'reason');
  if (reason.length < MINIMUM_REASON_LENGTH) throw new Error('SUPPORT_REASON_REQUIRED');
  return reason;
}

function required(form: FormData, name: string): string {
  const result = value(form, name);
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function value(form: FormData, name: string): string {
  const result = form.get(name);
  return typeof result === 'string' ? result.trim() : '';
}
