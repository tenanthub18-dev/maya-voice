'use server';

import {requireActionCapability} from '@/lib/auth/guards';
import {getDataSource} from '@/lib/data';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import {assertStrictFormData} from '@/lib/security/actions';

export async function setAgentEnabled(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['enabled']);
  await requireActionCapability('publishAgent');
  await getDataSource().setAgentEnabled(formData.get('enabled') === 'true');
  await invalidateAfterWrite();
}
