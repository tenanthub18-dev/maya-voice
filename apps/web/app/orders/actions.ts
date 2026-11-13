'use server';

import {redirect} from 'next/navigation';
import {requireActionCapability} from '@/lib/auth/guards';
import {getDataSource, type OrderStatus} from '@/lib/data';
import {assertStrictFormData} from '@/lib/security/actions';
import {invalidateAfterWrite} from '@/lib/data/invalidate';

// Next.js Server Action mutation/revalidation contract: https://nextjs.org/docs/app/getting-started/mutating-data
export async function changeOrderStatus(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'status']);
  await requireActionCapability('editOperations');
  const id = field(formData, 'id');
  const status = field(formData, 'status') as OrderStatus;
  if (!(['new', 'in-progress', 'ready'] as OrderStatus[]).includes(status)) redirect('/orders?error=UNKNOWN');
  try {
    await getDataSource().updateOrderStatus(id, status);
  } catch {
    redirect('/orders?error=UNKNOWN');
  }
  await invalidateAfterWrite();
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}
