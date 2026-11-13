// @vitest-environment jsdom

import {act, cleanup, fireEvent, render} from '@testing-library/react';
import {renderToString} from 'react-dom/server';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {LiveStatus, LiveSync} from '@/components/live-sync';
import {getLiveStore} from '@/lib/live/store';
import {createBroadcastTransport} from '@/lib/live/transports/broadcast';

const refresh = vi.fn();
let pathname = '/calls';
const realtimeCleanup = vi.fn();

vi.mock('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({refresh}),
}));
vi.mock('@/lib/data/supabase/client', () => ({createBrowserRealtimeClient: () => ({})}));
vi.mock('@/lib/live/transports/supabase-realtime', () => ({
  createRealtimeTransport: ({onConnection}: {onConnection: (status: string) => void}) => {
    onConnection('live');
    return {cleanup: realtimeCleanup};
  },
}));

type Message = {scope: string; nonce: string};
class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  readonly listeners = new Set<(event: MessageEvent<Message>) => void>();
  readonly close = vi.fn(() => FakeBroadcastChannel.channels.get(this.name)?.delete(this));
  constructor(readonly name: string) {
    const members = FakeBroadcastChannel.channels.get(name) ?? new Set();
    members.add(this);
    FakeBroadcastChannel.channels.set(name, members);
  }
  postMessage(message: Message) {
    for (const member of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (member === this) continue;
      for (const listener of member.listeners) listener(new MessageEvent('message', {data: message}));
    }
  }
  addEventListener(_type: 'message', listener: (event: MessageEvent<Message>) => void) { this.listeners.add(listener); }
  removeEventListener(_type: 'message', listener: (event: MessageEvent<Message>) => void) { this.listeners.delete(listener); }
}

beforeEach(() => {
  vi.useFakeTimers();
  refresh.mockReset();
  realtimeCleanup.mockReset();
  pathname = '/calls';
  FakeBroadcastChannel.channels.clear();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
});

afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LiveSync', () => {
  it('degrades BroadcastChannel operations to no-ops when the API is unavailable', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const transport = createBroadcastTransport();
    expect(() => {
      const unsubscribe = transport.subscribe(() => undefined);
      transport.post({scope: 'calls', nonce: 'write-1'});
      unsubscribe();
      transport.cleanup();
    }).not.toThrow();
  });

  it('announces localized demo and live connection states', () => {
    const labels = {live: 'Live', reconnecting: 'Reconnecting...', offline: 'Offline', demo: 'Demo data'};
    const view = render(<LiveStatus demo labels={labels} />);
    expect(view.getByRole('status').textContent).toContain('Demo data');
    view.rerender(<LiveStatus demo={false} labels={labels} />);
    act(() => getLiveStore().setConnection('live'));
    expect(view.getByRole('status').textContent).toContain('Live');
    expect(view.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('broadcasts one restaurant-scoped nonce when this tab observes its own write', () => {
    const receiver = new BroadcastChannel('maya-live') as unknown as FakeBroadcastChannel;
    const messages: Message[] = [];
    receiver.addEventListener('message', (event) => messages.push(event.data));
    const view = render(<LiveSync revisionNonce="old" restaurantId="restaurant-1" mode="demo" />);

    view.rerender(<LiveSync revisionNonce="write-1" restaurantId="restaurant-1" mode="demo" />);

    expect(messages).toEqual([{scope: 'restaurant', nonce: 'write-1'}]);
  });

  it('prevents a received nonce from ping-ponging back to the originating tab', () => {
    const sender = new BroadcastChannel('maya-live') as unknown as FakeBroadcastChannel;
    const senderMessages: Message[] = [];
    sender.addEventListener('message', (event) => senderMessages.push(event.data));
    const view = render(<LiveSync revisionNonce="old" restaurantId="restaurant-1" mode="demo" />);

    act(() => sender.postMessage({scope: 'calls', nonce: 'write-1'}));
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(<LiveSync revisionNonce="write-1" restaurantId="restaurant-1" mode="demo" />);
    expect(senderMessages).toEqual([]);
  });

  it('filters events that do not intersect the current route', () => {
    const sender = new BroadcastChannel('maya-live') as unknown as FakeBroadcastChannel;
    render(<LiveSync revisionNonce={null} restaurantId="restaurant-1" mode="demo" />);
    act(() => sender.postMessage({scope: 'orders', nonce: 'order-1'}));
    expect(refresh).not.toHaveBeenCalled();
    act(() => sender.postMessage({scope: 'calls', nonce: 'call-1'}));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('queues one refresh while hidden and flushes when visible', () => {
    const sender = new BroadcastChannel('maya-live') as unknown as FakeBroadcastChannel;
    render(<LiveSync revisionNonce={null} restaurantId="restaurant-1" mode="demo" />);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    act(() => {
      sender.postMessage({scope: 'calls', nonce: 'call-1'});
      sender.postMessage({scope: 'calls', nonce: 'call-2'});
    });
    expect(refresh).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not replace server output while a user is typing in main', () => {
    const sender = new BroadcastChannel('maya-live') as unknown as FakeBroadcastChannel;
    const input = document.createElement('input');
    const main = document.createElement('main');
    main.append(input);
    document.body.append(main);
    input.focus();
    render(<LiveSync revisionNonce={null} restaurantId="restaurant-1" mode="demo" />);
    act(() => sender.postMessage({scope: 'calls', nonce: 'call-1'}));
    expect(refresh).not.toHaveBeenCalled();
    act(() => fireEvent.blur(input));
    expect(refresh).toHaveBeenCalledTimes(1);
    main.remove();
  });

  it('keeps a hidden-tab remote refresh queued until the active editor blurs', () => {
    const sender = new BroadcastChannel('maya-live') as unknown as FakeBroadcastChannel;
    const input = document.createElement('input');
    const main = document.createElement('main');
    main.append(input);
    document.body.append(main);
    input.focus();
    render(<LiveSync revisionNonce={null} restaurantId="restaurant-1" mode="demo" />);
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'hidden'});
    act(() => sender.postMessage({scope: 'calls', nonce: 'call-1'}));
    Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(refresh).not.toHaveBeenCalled();
    act(() => fireEvent.blur(input));
    expect(refresh).toHaveBeenCalledTimes(1);
    main.remove();
  });

  it('cleans up broadcast and realtime subscriptions', async () => {
    const view = render(<LiveSync revisionNonce={null} restaurantId="restaurant-1" mode="supabase" />);
    await act(async () => Promise.resolve());
    const receiver = [...(FakeBroadcastChannel.channels.get('maya-live') ?? [])][0];
    view.unmount();
    expect(receiver?.close).toHaveBeenCalledTimes(1);
    expect(realtimeCleanup).toHaveBeenCalledTimes(1);
  });

  it('renders no client state or browser markup during SSR', () => {
    expect(renderToString(<LiveSync revisionNonce={null} restaurantId="restaurant-1" mode="demo" />)).toBe('');
  });
});
