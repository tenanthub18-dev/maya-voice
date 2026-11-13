import type {LiveScope} from '../events';

export type BroadcastLiveMessage = {scope: LiveScope; nonce: string};
type MessageListener = (message: BroadcastLiveMessage) => void;

const scopes = new Set<LiveScope>(['restaurant', 'calls', 'bookings', 'orders', 'messages', 'agent', 'usage']);

function isLiveMessage(value: unknown): value is BroadcastLiveMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as {scope?: unknown; nonce?: unknown};
  return typeof message.scope === 'string' && scopes.has(message.scope as LiveScope) && typeof message.nonce === 'string';
}

export function createBroadcastTransport(channelName = 'maya-live') {
  if (typeof BroadcastChannel === 'undefined') {
    return {
      post: () => undefined,
      subscribe: () => () => undefined,
      cleanup: () => undefined,
    };
  }

  const channel = new BroadcastChannel(channelName);
  const listeners = new Set<MessageListener>();
  const receive = (event: MessageEvent<unknown>) => {
    if (!isLiveMessage(event.data)) return;
    for (const listener of listeners) listener(event.data);
  };
  channel.addEventListener('message', receive);

  return {
    post(message: BroadcastLiveMessage) {
      channel.postMessage(message);
    },
    subscribe(listener: MessageListener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cleanup() {
      channel.removeEventListener('message', receive);
      listeners.clear();
      channel.close();
    },
  };
}
