import {describe, expect, it} from 'vitest';
import {calculateOrderTotals} from '@/lib/orders/totals';
import taxFixture from '../../../tests/fixtures/canadian-restaurant-tax.json';

describe('calculateOrderTotals', () => {
  it.each(taxFixture.jurisdictions)('matches the hand-calculated $province restaurant tax fixture', (fixture) => {
    expect(calculateOrderTotals([
      {quantity: 1, unitPriceCents: taxFixture.subtotal_cents, modifierPriceCents: []},
    ], fixture.rate_basis_points)).toEqual({
      subtotalCents: taxFixture.subtotal_cents,
      taxCents: fixture.tax_cents,
      totalCents: taxFixture.subtotal_cents + fixture.tax_cents,
    });
  });

  it('records the BC restaurant-food PST exemption and the QC GST plus QST basis', () => {
    expect(taxFixture.jurisdictions.find(({province}) => province === 'BC')?.note).toContain('exempt from BC PST');
    expect(taxFixture.jurisdictions.find(({province}) => province === 'QC')).toMatchObject({rate_basis_points: 1497.5});
  });
  it('adds quantity and modifier prices before applying tax', () => {
    expect(calculateOrderTotals([
      {quantity: 2, unitPriceCents: 1_000, modifierPriceCents: [125, 75]},
      {quantity: 1, unitPriceCents: 500, modifierPriceCents: []}
    ], 1_300)).toEqual({subtotalCents: 2_900, taxCents: 377, totalCents: 3_277});
  });

  it('rounds tax once on the order subtotal at the half-cent boundary', () => {
    expect(calculateOrderTotals([{quantity: 1, unitPriceCents: 50, modifierPriceCents: []}], 1_300)).toEqual({
      subtotalCents: 50,
      taxCents: 7,
      totalCents: 57
    });
  });

  it('does not round tax per line', () => {
    expect(calculateOrderTotals([
      {quantity: 1, unitPriceCents: 5, modifierPriceCents: []},
      {quantity: 1, unitPriceCents: 5, modifierPriceCents: []}
    ], 1_300)).toEqual({subtotalCents: 10, taxCents: 1, totalCents: 11});
  });

  it('returns zero totals for an empty order', () => {
    expect(calculateOrderTotals([], 1_300)).toEqual({subtotalCents: 0, taxCents: 0, totalCents: 0});
  });

  it('rejects invalid integer and negative money inputs', () => {
    expect(() => calculateOrderTotals([{quantity: 0, unitPriceCents: 100, modifierPriceCents: []}], 1_300)).toThrow();
    expect(() => calculateOrderTotals([{quantity: 1, unitPriceCents: -1, modifierPriceCents: []}], 1_300)).toThrow();
    expect(() => calculateOrderTotals([{quantity: 1, unitPriceCents: 100, modifierPriceCents: [0.5]}], 1_300)).toThrow();
    expect(() => calculateOrderTotals([{quantity: 1, unitPriceCents: 100, modifierPriceCents: []}], -1)).toThrow();
  });
});
