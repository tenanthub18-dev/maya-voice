import type {LiveConnection} from '../store';
import type {LiveEvent, LiveScope} from '../events';

type PostgresFilter = {event: '*'; schema: 'public'; table: string; filter: string};
type RealtimeChannel = {
  on: (kind: 'postgres_changes', filter: PostgresFilter, callback: (payload: unknown) => void) => RealtimeChannel;
  subscribe: (callback: (status: string) => void) => RealtimeChannel;
  unsubscribe: () => unknown;
};
type RealtimeClient = {channel: (name: string) => RealtimeChannel};

const tableScopes = [
  ['calls', 'calls'],
  ['bookings', 'bookings'],
  ['orders', 'orders'],
  ['messages', 'messages'],
  ['agent_versions', 'agent'],
  ['restaurants', 'restaurant'],
] as const satisfies ReadonlyArray<readonly [string, LiveScope]>;

export function createRealtimeTransport({
  client,
  restaurantId,
  onEvent,
  onConnection,
  now = Date.now,
}: {
  client: RealtimeClient;
  restaurantId: string;
  onEvent: (event: LiveEvent) => void;
  onConnection: (connection: LiveConnection) => void;
  now?: () => number;
}) {
  const channel = client.channel(`restaurant-live:${restaurantId}`);
  for (const [table, scope] of tableScopes) {
    // Supabase Postgres Changes API: https://supabase.com/docs/guides/realtime/postgres-changes
    channel.on('postgres_changes', {
      event: '*',
      schema: 'public',
      table,
      filter: `restaurant_id=eq.${restaurantId}`,
    }, () => onEvent({scope, source: 'realtime', at: now()}));
  }
  channel.subscribe((status) => {
    if (status === 'SUBSCRIBED') onConnection('live');
    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onConnection('reconnecting');
    else if (status === 'CLOSED') onConnection('offline');
  });

  return {cleanup: () => { void channel.unsubscribe(); }};
}
