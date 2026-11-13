// @vitest-environment jsdom

import {describe, expect, it, vi} from 'vitest';
import {createBrowserRealtimeClient} from '@/lib/data/supabase/client';
import {createRealtimeTransport} from '@/lib/live/transports/supabase-realtime';

describe('Supabase realtime transport', () => {
  it('configures the browser transport with authenticated RLS token refresh', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co/');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'publishable-key');

    const client = createBrowserRealtimeClient();

    expect(client.accessToken).toEqual(expect.any(Function));
    expect(client.apiKey).toBe('publishable-key');
    vi.unstubAllEnvs();
  });

  it('subscribes to every live table with a restaurant filter and maps events', () => {
    const handlers: Array<{filter: Record<string, string>; callback: () => void}> = [];
    let statusCallback: ((status: string) => void) | undefined;
    const channel = {
      on: vi.fn((_kind, filter, callback) => {
        handlers.push({filter, callback});
        return channel;
      }),
      subscribe: vi.fn((callback) => {
        statusCallback = callback;
        return channel;
      }),
      unsubscribe: vi.fn(),
    };
    const onEvent = vi.fn();
    const onConnection = vi.fn();

    const transport = createRealtimeTransport({
      client: {channel: vi.fn(() => channel)},
      restaurantId: 'restaurant-123',
      onEvent,
      onConnection,
      now: () => 77,
    });

    expect(handlers.map(({filter}) => filter)).toEqual([
      {event: '*', schema: 'public', table: 'calls', filter: 'restaurant_id=eq.restaurant-123'},
      {event: '*', schema: 'public', table: 'bookings', filter: 'restaurant_id=eq.restaurant-123'},
      {event: '*', schema: 'public', table: 'orders', filter: 'restaurant_id=eq.restaurant-123'},
      {event: '*', schema: 'public', table: 'messages', filter: 'restaurant_id=eq.restaurant-123'},
      {event: '*', schema: 'public', table: 'agent_versions', filter: 'restaurant_id=eq.restaurant-123'},
      {event: '*', schema: 'public', table: 'restaurants', filter: 'restaurant_id=eq.restaurant-123'},
    ]);
    for (const handler of handlers) handler.callback();
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual([
      {scope: 'calls', source: 'realtime', at: 77},
      {scope: 'bookings', source: 'realtime', at: 77},
      {scope: 'orders', source: 'realtime', at: 77},
      {scope: 'messages', source: 'realtime', at: 77},
      {scope: 'agent', source: 'realtime', at: 77},
      {scope: 'restaurant', source: 'realtime', at: 77},
    ]);

    statusCallback?.('SUBSCRIBED');
    statusCallback?.('CHANNEL_ERROR');
    statusCallback?.('TIMED_OUT');
    statusCallback?.('CLOSED');
    expect(onConnection.mock.calls.map(([status]) => status)).toEqual(['live', 'reconnecting', 'reconnecting', 'offline']);

    transport.cleanup();
    expect(channel.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
