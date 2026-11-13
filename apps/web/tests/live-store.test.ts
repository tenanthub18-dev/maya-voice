// @vitest-environment jsdom

import {performance} from 'node:perf_hooks';
import {act, cleanup, render, screen} from '@testing-library/react';
import {createElement, Fragment} from 'react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {createLiveStore, getLiveStore, useLiveStoreSelector} from '@/lib/live/store';

afterEach(cleanup);

describe('live signal store', () => {
  it('keeps the server snapshot constant and ignores server-side mutations', () => {
    vi.stubGlobal('window', undefined);
    const store = getLiveStore();
    store.setConnection('live');
    store.emit({scope: 'calls', source: 'realtime', at: 99});
    expect(store.getSnapshot()).toEqual({connection: 'idle', lastEventAt: null});
    vi.unstubAllGlobals();
  });

  it('fans events out without retaining entity data', () => {
    const store = createLiveStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribeEvents(listener);

    store.emit({scope: 'calls', source: 'local', at: 42});

    expect(listener).toHaveBeenCalledWith({scope: 'calls', source: 'local', at: 42});
    expect(store.getSnapshot()).toEqual({connection: 'idle', lastEventAt: 42});
    expect(Object.keys(store.getSnapshot())).toEqual(['connection', 'lastEventAt']);
    unsubscribe();
    store.emit({scope: 'orders', source: 'realtime', at: 43});
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('only rerenders consumers whose selected signal changed', () => {
    const store = createLiveStore();
    const connectionRenders = vi.fn();
    const eventRenders = vi.fn();
    function Connection() {
      connectionRenders();
      return createElement('span', null, useLiveStoreSelector(store, (state) => state.connection));
    }
    function LastEvent() {
      eventRenders();
      return createElement('span', null, useLiveStoreSelector(store, (state) => state.lastEventAt));
    }
    render(createElement(Fragment, null, createElement(Connection), createElement(LastEvent)));

    act(() => store.emit({scope: 'calls', source: 'realtime', at: 10}));

    expect(screen.getByText('idle')).toBeTruthy();
    expect(screen.getByText('10')).toBeTruthy();
    expect(connectionRenders).toHaveBeenCalledTimes(1);
    expect(eventRenders).toHaveBeenCalledTimes(2);
  });

  it('delivers 1,000 events to 50 subscribers in under 50 ms', () => {
    const store = createLiveStore();
    for (let index = 0; index < 50; index += 1) store.subscribeEvents(() => undefined);
    const startedAt = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      store.emit({scope: 'calls', source: 'realtime', at: index});
    }
    expect(performance.now() - startedAt).toBeLessThan(50);
  });
});
