export function validateSpendCap(value: string): {valid: boolean; cents: number | null} {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return {valid: false, cents: null};
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount <= 0) return {valid: false, cents: null};
  return {valid: true, cents: Math.round(amount * 100)};
}

export function validateRetentionDays(value: string): {valid: boolean; days: number | null} {
  const normalized = value.trim();
  if (!/^\d+$/u.test(normalized)) return {valid: false, days: null};
  const days = Number(normalized);
  return Number.isSafeInteger(days) && days >= 30 && days <= 365
    ? {valid: true, days}
    : {valid: false, days: null};
}
