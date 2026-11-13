import {describe, expect, test} from 'vitest';
import {validateRetentionDays, validateSpendCap} from '@/lib/settings';

describe('validateSpendCap', () => {
  test.each(['', '0', '-1', '20.999', 'not-a-number'])('rejects an invalid CAD amount: %s', (value) => {
    expect(validateSpendCap(value)).toEqual({valid: false, cents: null});
  });

  test('converts a positive amount with at most two decimals into cents', () => {
    expect(validateSpendCap('125.50')).toEqual({valid: true, cents: 12_550});
  });
});

describe('validateRetentionDays', () => {
  test.each(['', '29', '366', '90.5', 'not-a-number'])('rejects a retention period outside 30-365 days: %s', (value) => {
    expect(validateRetentionDays(value)).toEqual({valid: false, days: null});
  });

  test.each(['30', '90', '365'])('accepts an integer retention period in range: %s', (value) => {
    expect(validateRetentionDays(value)).toEqual({valid: true, days: Number(value)});
  });
});
