'use server';

import {redirect} from 'next/navigation';
import {requireActionCapability} from '@/lib/auth/guards';
import {localDateTimeToIso} from '@/lib/bookings/calendar';
import {getDataSource, type BookingStatus, type SaveBookingInput} from '@/lib/data';
import {assertStrictFormData} from '@/lib/security/actions';
import {invalidateAfterWrite} from '@/lib/data/invalidate';
import {getCurrentRestaurant} from '@/lib/restaurant';

// Next.js Server Action mutation/revalidation contract: https://nextjs.org/docs/app/getting-started/mutating-data
const bookingErrors = new Set(['NAME_REQUIRED', 'PHONE_INVALID', 'PARTY_SIZE_INVALID', 'MAX_PARTY', 'START_INVALID', 'LEAD_TIME', 'BOOKING_WINDOW', 'BLACKOUT_DATE', 'CAPACITY']);

export async function saveBooking(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'name', 'phoneE164', 'partySize', 'startsAt', 'notes']);
  await requireActionCapability('editOperations');
  const source = getDataSource();
  const restaurant = await getCurrentRestaurant();
  const id = field(formData, 'id');
  let error = '';
  try {
    const input: SaveBookingInput = {
      name: field(formData, 'name'),
      phoneE164: field(formData, 'phoneE164'),
      partySize: Number(field(formData, 'partySize')),
      startsAt: localDateTimeToIso(field(formData, 'startsAt'), restaurant.timezone),
      notes: field(formData, 'notes')
    };
    if (id) await source.updateBooking(id, input);
    else await source.createBooking(input);
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : '';
    error = bookingErrors.has(message) ? message : 'UNKNOWN';
  }
  if (error) redirect(`/bookings?view=list&${id ? `edit=${encodeURIComponent(id)}&` : 'create=1&'}error=${error}`);
  await invalidateAfterWrite();
  redirect('/bookings?view=list&saved=1');
}

export async function changeBookingStatus(formData: FormData): Promise<void> {
  assertStrictFormData(formData, ['id', 'status']);
  await requireActionCapability('editOperations');
  const status = field(formData, 'status') as BookingStatus;
  if (!(['confirmed', 'seated', 'cancelled', 'no-show'] as BookingStatus[]).includes(status)) redirect('/bookings?error=UNKNOWN');
  await getDataSource().updateBookingStatus(field(formData, 'id'), status);
  await invalidateAfterWrite();
}

function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}
