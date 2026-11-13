export function billableSeconds(
  durationSeconds: number | null | undefined,
  cachedBillableSeconds?: number | null,
): number {
  if (durationSeconds === null || durationSeconds === undefined) {
    throw new Error('Billable duration is required');
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new Error('Billable duration must be a non-negative number');
  }
  if (cachedBillableSeconds !== null && cachedBillableSeconds !== undefined
    && (!Number.isFinite(cachedBillableSeconds) || cachedBillableSeconds < 0)) {
    throw new Error('Cached billable seconds must be a non-negative number');
  }
  const duration = Math.ceil(durationSeconds / 6) * 6;
  const cached = cachedBillableSeconds === null || cachedBillableSeconds === undefined
    ? 0
    : Math.ceil(cachedBillableSeconds / 6) * 6;
  return Math.max(duration, cached);
}
