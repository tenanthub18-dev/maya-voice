export interface OrderTotalLine {
  quantity: number;
  unitPriceCents: number;
  modifierPriceCents: readonly number[];
}

export interface OrderTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function calculateOrderTotals(lines: readonly OrderTotalLine[], taxRateBasisPoints: number): OrderTotals {
  assertNonNegativeRate(taxRateBasisPoints);
  const subtotalCents = lines.reduce((subtotal, line) => {
    assertPositiveInteger(line.quantity, 'quantity');
    assertNonNegativeInteger(line.unitPriceCents, 'unitPriceCents');
    const unitTotal = line.modifierPriceCents.reduce((sum, price) => {
      assertNonNegativeInteger(price, 'modifierPriceCents');
      return safeAdd(sum, price);
    }, line.unitPriceCents);
    return safeAdd(subtotal, safeMultiply(unitTotal, line.quantity));
  }, 0);
  const taxCents = Math.round(safeRateProduct(subtotalCents, taxRateBasisPoints) / 10_000);
  return {subtotalCents, taxCents, totalCents: safeAdd(subtotalCents, taxCents)};
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative integer`);
}

function assertNonNegativeRate(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('taxRateBasisPoints must be non-negative');
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Order total exceeds safe integer range');
  return result;
}

function safeMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new RangeError('Order total exceeds safe integer range');
  return result;
}

function safeRateProduct(subtotalCents: number, taxRateBasisPoints: number): number {
  const result = subtotalCents * taxRateBasisPoints;
  if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new RangeError('Order tax exceeds safe integer range');
  return result;
}
