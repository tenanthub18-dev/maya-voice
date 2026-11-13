'use client';

import {useSyncExternalStore} from 'react';
import type {LiveEvent} from './events';

export type LiveConnection = 'idle' | 'live' | 'reconnecting' | 'offline' | 'demo';
export type LiveState = Readonly<{connection: LiveConnection; lastEventAt: number | null}>;
type StateListener = () => void;
type EventListener = (event: LiveEvent) => void;

const SERVER_SNAPSHOT: LiveState = Object.freeze({connection: 'idle', lastEventAt: null});

export type LiveStore = ReturnType<typeof createLiveStore>;

export function createLiveStore(initialConnection: LiveConnection = 'idle') {
  let snapshot: LiveState = {connection: initialConnection, lastEventAt: null};
  const stateListeners = new Set<StateListener>();
  const eventListeners = new Set<EventListener>();

  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,
    subscribe(listener: StateListener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeEvents(listener: EventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    emit(event: LiveEvent) {
      snapshot = {...snapshot, lastEventAt: event.at};
      for (const listener of eventListeners) listener(event);
      for (const listener of stateListeners) listener();
    },
    setConnection(connection: LiveConnection) {
      if (snapshot.connection === connection) return;
      snapshot = {...snapshot, connection};
      for (const listener of stateListeners) listener();
    },
  };
}

let clientStore: LiveStore | undefined;

const serverStore: LiveStore = {
  getSnapshot: () => SERVER_SNAPSHOT,
  getServerSnapshot: () => SERVER_SNAPSHOT,
  subscribe: () => () => false,
  subscribeEvents: () => () => false,
  emit: () => undefined,
  setConnection: () => undefined,
};

export function getLiveStore(): LiveStore {
  if (typeof window === 'undefined') return serverStore;
  return (clientStore ??= createLiveStore());
}

export function emit(event: LiveEvent): void {
  if (typeof window !== 'undefined') getLiveStore().emit(event);
}

export function setConnection(connection: LiveConnection): void {
  if (typeof window !== 'undefined') getLiveStore().setConnection(connection);
}

export function useLiveStoreSelector<T>(store: LiveStore, selector: (state: LiveState) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getServerSnapshot()),
  );
}

export function useLiveConnection(): LiveConnection {
  const store = getLiveStore();
  return useLiveStoreSelector(store, (state) => state.connection);
}
