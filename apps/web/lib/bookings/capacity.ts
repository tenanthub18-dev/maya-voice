export interface SlotCapacityConfig {
  slotMinutes: number;
  coversPerSlot: number;
  seatingMinutes: number;
}

export interface CapacityBooking {
  id: string;
  partySize: number;
  startsAt: string;
  status: 'confirmed' | 'seated' | 'cancelled' | 'no-show';
}

export interface BookingCandidate {
  partySize: number;
  startsAt: string;
}

export interface CapacityResult {
  available: boolean;
  peakCovers: number;
  capacity: number;
}

const MINUTE_MS = 60_000;

export function checkBookingCapacity(
  bookings: readonly CapacityBooking[],
  candidate: BookingCandidate,
  config: SlotCapacityConfig
): CapacityResult {
  assertPositiveInteger(config.slotMinutes, 'slotMinutes');
  assertPositiveInteger(config.coversPerSlot, 'coversPerSlot');
  assertPositiveInteger(config.seatingMinutes, 'seatingMinutes');
  if (config.seatingMinutes % config.slotMinutes !== 0) throw new RangeError('seatingMinutes must be divisible by slotMinutes');

  const slotMs = config.slotMinutes * MINUTE_MS;
  const seatingMs = config.seatingMinutes * MINUTE_MS;
  const candidateStart = parseSlot(candidate.startsAt, slotMs);
  assertPositiveInteger(candidate.partySize, 'partySize');

  const activeBookings = bookings
    .filter((booking) => booking.status !== 'cancelled' && booking.status !== 'no-show')
    .map((booking) => {
      assertPositiveInteger(booking.partySize, 'booking.partySize');
      return {...booking, startMs: parseSlot(booking.startsAt, slotMs)};
    });

  let peakCovers = candidate.partySize;
  for (let slotStart = candidateStart; slotStart < candidateStart + seatingMs; slotStart += slotMs) {
    const existingCovers = activeBookings.reduce((sum, booking) => {
      const overlaps = booking.startMs < slotStart + slotMs && booking.startMs + seatingMs > slotStart;
      return overlaps ? sum + booking.partySize : sum;
    }, 0);
    peakCovers = Math.max(peakCovers, existingCovers + candidate.partySize);
  }

  return {available: peakCovers <= config.coversPerSlot, peakCovers, capacity: config.coversPerSlot};
}

function parseSlot(value: string, slotMs: number): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new RangeError('startsAt must be a valid ISO date');
  if (timestamp % slotMs !== 0) throw new RangeError('startsAt must align with slotMinutes');
  return timestamp;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
}
