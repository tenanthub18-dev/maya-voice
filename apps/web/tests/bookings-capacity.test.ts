import {describe, expect, it} from 'vitest';
import {checkBookingCapacity, type CapacityBooking, type SlotCapacityConfig} from '@/lib/bookings/capacity';

const config: SlotCapacityConfig = {
  slotMinutes: 15,
  coversPerSlot: 8,
  seatingMinutes: 90
};

const booking = (id: string, partySize: number, startsAt: string, status: CapacityBooking['status'] = 'confirmed'): CapacityBooking => ({
  id,
  partySize,
  startsAt,
  status
});

describe('checkBookingCapacity', () => {
  it('accepts a party that reaches the exact cover limit', () => {
    const existing = [booking('first', 5, '2026-10-27T22:00:00.000Z')];

    expect(checkBookingCapacity(existing, {partySize: 3, startsAt: '2026-10-27T22:15:00.000Z'}, config)).toEqual({
      available: true,
      peakCovers: 8,
      capacity: 8
    });
  });

  it('rejects a party that exceeds capacity in any occupied slot', () => {
    const existing = [booking('first', 6, '2026-10-27T22:00:00.000Z')];

    expect(checkBookingCapacity(existing, {partySize: 3, startsAt: '2026-10-27T23:15:00.000Z'}, config)).toEqual({
      available: false,
      peakCovers: 9,
      capacity: 8
    });
  });

  it('does not count a seating that ends exactly when the candidate starts', () => {
    const existing = [booking('first', 8, '2026-10-27T22:00:00.000Z')];

    expect(checkBookingCapacity(existing, {partySize: 8, startsAt: '2026-10-27T23:30:00.000Z'}, config).available).toBe(true);
  });

  it('ignores cancelled bookings', () => {
    const existing = [booking('cancelled', 8, '2026-10-27T22:00:00.000Z', 'cancelled')];

    expect(checkBookingCapacity(existing, {partySize: 8, startsAt: '2026-10-27T22:00:00.000Z'}, config).available).toBe(true);
  });

  it('releases capacity held by no-show bookings', () => {
    const existing = [booking('no-show', 8, '2026-10-27T22:00:00.000Z', 'no-show')];

    expect(checkBookingCapacity(existing, {partySize: 8, startsAt: '2026-10-27T22:00:00.000Z'}, config).available).toBe(true);
  });

  it('rejects the second concurrent-style candidate after the first is included', () => {
    const snapshot = [booking('existing', 4, '2026-10-27T22:00:00.000Z')];
    const first = {partySize: 4, startsAt: '2026-10-27T22:15:00.000Z'};
    const second = {partySize: 4, startsAt: '2026-10-27T22:30:00.000Z'};

    expect(checkBookingCapacity(snapshot, first, config).available).toBe(true);
    expect(checkBookingCapacity(snapshot, second, config).available).toBe(true);
    expect(checkBookingCapacity([...snapshot, booking('first', first.partySize, first.startsAt)], second, config).available).toBe(false);
  });

  it('rejects invalid slot configuration and candidates', () => {
    expect(() => checkBookingCapacity([], {partySize: 0, startsAt: '2026-10-27T22:00:00.000Z'}, config)).toThrow();
    expect(() => checkBookingCapacity([], {partySize: 2, startsAt: 'not-a-date'}, config)).toThrow();
    expect(() => checkBookingCapacity([], {partySize: 2, startsAt: '2026-10-27T22:07:00.000Z'}, config)).toThrow();
  });
});
