import {describe, expect, it} from 'vitest';
import {splitMobileNavigation} from '@/lib/navigation';

describe('mobile navigation items', () => {
  it('keeps four primary tabs and moves the remaining routes into More', () => {
    const navigation = splitMobileNavigation();

    expect(navigation.primary.map((item) => item.key)).toEqual([
      'home',
      'calls',
      'bookings',
      'orders'
    ]);
    expect(navigation.more.map((item) => item.key)).toEqual([
      'agent',
      'phone',
      'analytics',
      'settings'
    ]);
  });
});
