import {describe, expect, it} from 'vitest';
import {getCallDurationSeconds, getCallUsageSummary} from '@/lib/calls';
import {browserCall} from './fixtures/browser-call';

describe('persisted browser usage', () => {
  it('reads snake_case v1 JSON and sums only priced services, not the legacy map again', () => {
    const summary = getCallUsageSummary(browserCall());
    expect(summary.costMicros).toBe(700);
    expect(summary.status).toBe('partial');
    expect(summary.totals?.total_tokens).toBe(1200);
    expect(summary.totals?.cache_read_input_tokens).toBe(400);
    expect(summary.services[1].cost_micros).toBeNull();
  });
  it('retains explicitly reported zero usage without treating absent historical usage as zero', () => {
    const call = browserCall(); call.usage!.totals.total_tokens = 0;
    expect(getCallUsageSummary(call).totals?.total_tokens).toBe(0);
    expect(getCallUsageSummary(browserCall({usage: undefined}))).toMatchObject({costMicros: null, totals: null, status: 'unavailable'});
  });
  it.each([{schema_version: 2}, {currency: 'CAD'}, {cost_status: 'unavailable'}])('never labels unsupported or unavailable costs as USD: %s', (override) => {
    const call = browserCall(); Object.assign(call.usage!, override);
    expect(getCallUsageSummary(call).costMicros).toBeNull();
    expect(getCallUsageSummary(call).status).toBe('unavailable');
  });
  it('treats an empty service report as unavailable, and unfinished usage as incomplete', () => {
    const call = browserCall(); call.usage!.services = []; call.usage!.usage_complete = false;
    expect(getCallUsageSummary(call)).toMatchObject({costMicros: null, status: 'unavailable', incomplete: true});
  });
  it('rejects invalid numeric values rather than printing NaN or negative USD', () => {
    const call = browserCall(); call.usage!.services[0].cost_micros = NaN; call.usage!.services[2].cost_micros = -1; call.usage!.totals.prompt_tokens = Infinity;
    expect(getCallUsageSummary(call).costMicros).toBeNull();
    expect(getCallUsageSummary(call).totals?.prompt_tokens).toBeNull();
  });
  it('uses elapsed browser duration but retains legacy phone billable duration', () => {
    expect(getCallDurationSeconds(browserCall())).toBe(65);
    expect(getCallDurationSeconds(browserCall({endedAt: null}), Date.parse('2026-11-12T12:02:10Z'))).toBe(130);
    expect(getCallDurationSeconds(browserCall({source: undefined, billableSeconds: 12}))).toBe(12);
    expect(getCallDurationSeconds(browserCall({endedAt: 'bad'}))).toBe(0);
    expect(getCallDurationSeconds(browserCall({endedAt: '2026-11-11'}))).toBe(0);
  });
});
