import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createRefreshScheduler} from '@/lib/live/coalesce';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const timers = {
  now: () => Date.now(),
  setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
};

describe('refresh coalescing', () => {
  it('limits 50 local events in 100 ms to a leading and trailing refresh', () => {
    const refresh = vi.fn();
    const scheduler = createRefreshScheduler({refresh, delayMs: 120, maxWaitMs: 1_000, timers});
    for (let index = 0; index < 50; index += 1) {
      scheduler.schedule({scope: 'calls', source: 'local', at: Date.now()});
      vi.advanceTimersByTime(2);
    }
    vi.advanceTimersByTime(120);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('trails realtime bursts and enforces the maximum wait', () => {
    const refresh = vi.fn();
    const scheduler = createRefreshScheduler({refresh, delayMs: 120, maxWaitMs: 1_000, timers});
    for (let elapsed = 0; elapsed < 1_000; elapsed += 100) {
      scheduler.schedule({scope: 'orders', source: 'realtime', at: Date.now()});
      vi.advanceTimersByTime(100);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('continues scheduling after refresh throws', () => {
    const refresh = vi.fn().mockImplementationOnce(() => { throw new Error('render failed'); });
    const scheduler = createRefreshScheduler({refresh, timers});
    expect(() => scheduler.schedule({scope: 'calls', source: 'local', at: 1})).not.toThrow();
    vi.advanceTimersByTime(200);
    scheduler.schedule({scope: 'calls', source: 'local', at: 2});
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('continues scheduling after an asynchronous refresh rejection', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('render failed'));
    const scheduler = createRefreshScheduler({refresh, timers});
    scheduler.schedule({scope: 'calls', source: 'local', at: 1});
    await Promise.resolve();
    vi.advanceTimersByTime(200);
    scheduler.schedule({scope: 'calls', source: 'local', at: 2});
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('cancels pending work on dispose', () => {
    const refresh = vi.fn();
    const scheduler = createRefreshScheduler({refresh, timers});
    scheduler.schedule({scope: 'calls', source: 'realtime', at: 1});
    scheduler.dispose();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
  });
});
