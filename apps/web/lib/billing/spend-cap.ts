export interface SpendCapInput {
  currentCostMicros: number;
  projectedCallCostMicros: number;
  spendCapCents: number;
}

export interface SpendCapDecision {
  allowed: boolean;
  warning: boolean;
  utilization: number;
}

export function evaluateSpendCap(input: SpendCapInput): SpendCapDecision {
  for (const value of [input.currentCostMicros, input.projectedCallCostMicros, input.spendCapCents]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Spend cap values must be non-negative safe integers');
  }
  const capMicros = input.spendCapCents * 10_000;
  const projectedMicros = input.currentCostMicros + input.projectedCallCostMicros;
  const utilization = capMicros === 0 ? Number.POSITIVE_INFINITY : projectedMicros / capMicros;
  return {
    allowed: projectedMicros < capMicros,
    warning: utilization >= 0.8,
    utilization,
  };
}
