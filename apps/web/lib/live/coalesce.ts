import type {LiveEvent} from './events';

type TimerHandle = ReturnType<typeof setTimeout>;
type SchedulerTimers = {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

type RefreshSchedulerOptions = {
  refresh: () => void | Promise<void>;
  delayMs?: number;
  maxWaitMs?: number;
  timers?: SchedulerTimers;
};

const defaultTimers: SchedulerTimers = {
  now: Date.now,
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export function createRefreshScheduler({
  refresh,
  delayMs = 120,
  maxWaitMs = 1_000,
  timers = defaultTimers,
}: RefreshSchedulerOptions) {
  let active = false;
  let dirty = false;
  let startedAt = 0;
  let timer: TimerHandle | undefined;

  function runRefresh(): void {
    try {
      Promise.resolve(refresh()).catch(() => undefined);
    } catch {
      // A render failure must not disable later refreshes.
    }
  }

  function reset(): void {
    active = false;
    dirty = false;
    timer = undefined;
  }

  function flush(): void {
    if (dirty) runRefresh();
    reset();
  }

  function arm(now: number): void {
    if (timer !== undefined) timers.clearTimeout(timer);
    const remaining = Math.max(0, maxWaitMs - (now - startedAt));
    timer = timers.setTimeout(flush, Math.min(delayMs, remaining));
  }

  return {
    schedule(event: LiveEvent) {
      const now = timers.now();
      if (!active) {
        active = true;
        startedAt = now;
        if (event.source === 'realtime') dirty = true;
        else runRefresh();
      } else {
        dirty = true;
      }
      arm(now);
    },
    dispose() {
      if (timer !== undefined) timers.clearTimeout(timer);
      reset();
    },
  };
}
