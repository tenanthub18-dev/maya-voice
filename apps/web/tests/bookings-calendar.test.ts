import {describe, expect, it} from 'vitest';
import {addCalendarDays, formatDateKey, localDateTimeToIso, localInputValue} from '@/lib/bookings/calendar';

describe('booking calendar timezone helpers', () => {
  it('converts Toronto summer and winter wall times to UTC', () => {
    expect(localDateTimeToIso('2026-10-27T18:30', 'America/Toronto')).toBe('2026-10-27T22:30:00.000Z');
    expect(localDateTimeToIso('2026-12-27T18:30', 'America/Toronto')).toBe('2026-12-27T23:30:00.000Z');
  });

  it('rejects a nonexistent daylight-saving wall time', () => {
    expect(() => localDateTimeToIso('2026-03-08T02:30', 'America/Toronto')).toThrow();
  });

  it('formats instants and form values in the restaurant timezone', () => {
    const instant = new Date('2026-10-27T22:30:00.000Z');
    expect(formatDateKey(instant, 'America/Toronto')).toBe('2026-10-27');
    expect(localInputValue(instant, 'America/Toronto')).toBe('2026-10-27T18:30');
  });

  it('adds calendar days without local daylight-saving drift', () => {
    expect(addCalendarDays('2026-10-31', 2)).toBe('2026-11-02');
  });
});
