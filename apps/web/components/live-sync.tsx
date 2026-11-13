'use client';

import {usePathname, useRouter} from 'next/navigation';
import {useEffect, useRef} from 'react';
import {createRefreshScheduler} from '@/lib/live/coalesce';
import {scopesForPath, type LiveEvent} from '@/lib/live/events';
import {emit, setConnection, useLiveConnection} from '@/lib/live/store';
import {createBroadcastTransport} from '@/lib/live/transports/broadcast';

type LiveStatusLabels = {live: string; reconnecting: string; offline: string; demo: string};

export function LiveStatus({demo, labels}: {demo: boolean; labels: LiveStatusLabels}) {
  const connection = useLiveConnection();
  const status = demo ? 'demo' : connection;
  const displayStatus = status === 'idle' ? 'reconnecting' : status;
  const label = labels[displayStatus];
  const dotClass = displayStatus === 'live'
    ? 'bg-[var(--success)]'
    : displayStatus === 'offline'
      ? 'bg-[var(--danger)]'
      : displayStatus === 'demo'
        ? 'bg-[var(--accent-strong)]'
        : 'bg-[var(--warning)]';

  return (
    <span role="status" aria-live="polite" className="inline-flex w-fit items-center gap-1.5 rounded-full border bg-[var(--surface-raised)] px-2 py-1 text-xs font-semibold text-[var(--muted)]">
      <span aria-hidden="true" className={`size-2 rounded-full ${dotClass}`} />
      {label}
    </span>
  );
}

export function LiveSync({
  revisionNonce,
  restaurantId,
  mode,
}: {
  revisionNonce: string | null;
  restaurantId: string;
  mode: 'demo' | 'supabase';
}) {
  const pathname = usePathname();
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  const lastSeenNonce = useRef<string | null>(revisionNonce);
  const broadcastRef = useRef<ReturnType<typeof createBroadcastTransport> | null>(null);
  const handleEventRef = useRef<(event: LiveEvent) => void>(() => undefined);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    let disposed = false;
    let realtimeCleanup: (() => void) | undefined;
    let queuedEvent: LiveEvent | null = null;
    let typingTarget: HTMLElement | null = null;
    const scheduler = createRefreshScheduler({refresh: () => router.refresh()});
    const broadcast = createBroadcastTransport();
    broadcastRef.current = broadcast;

    function removeTypingListener(): void {
      typingTarget?.removeEventListener('blur', flushAfterTyping);
      typingTarget = null;
    }

    function flushQueued(): void {
      if (!queuedEvent || document.visibilityState === 'hidden') return;
      if (queuedEvent.source !== 'local' && isTypingInMain()) {
        watchActiveEditor();
        return;
      }
      const event = queuedEvent;
      queuedEvent = null;
      scheduler.schedule(event);
    }

    function flushAfterTyping(): void {
      removeTypingListener();
      if (!queuedEvent || document.visibilityState === 'hidden') return;
      const event = queuedEvent;
      queuedEvent = null;
      scheduler.schedule(event);
    }

    function isTypingInMain(): boolean {
      const active = document.activeElement;
      return active instanceof HTMLElement
        && active.matches('input, textarea, select')
        && active.closest('main') !== null;
    }

    function watchActiveEditor(): void {
      const active = document.activeElement as HTMLElement;
      if (typingTarget === active) return;
      removeTypingListener();
      typingTarget = active;
      typingTarget.addEventListener('blur', flushAfterTyping, {once: true});
    }

    function handleEvent(event: LiveEvent): void {
      emit(event);
      const routeScopes = scopesForPath(pathnameRef.current);
      if (event.scope !== 'restaurant' && !routeScopes.includes(event.scope)) return;
      if (document.visibilityState === 'hidden') {
        queuedEvent = event;
        return;
      }
      if (event.source !== 'local' && isTypingInMain()) {
        queuedEvent = event;
        watchActiveEditor();
        return;
      }
      scheduler.schedule(event);
    }

    handleEventRef.current = handleEvent;
    const unsubscribeBroadcast = broadcast.subscribe((message) => {
      lastSeenNonce.current = message.nonce;
      handleEvent({scope: message.scope, source: 'broadcast', at: Date.now()});
    });
    const handleVisibility = () => flushQueued();
    document.addEventListener('visibilitychange', handleVisibility);

    if (mode === 'demo') {
      setConnection('demo');
    } else {
      setConnection('reconnecting');
      void Promise.all([
        import('@/lib/data/supabase/client'),
        import('@/lib/live/transports/supabase-realtime'),
      ]).then(([{createBrowserRealtimeClient}, {createRealtimeTransport}]) => {
        const transport = createRealtimeTransport({
          client: createBrowserRealtimeClient(),
          restaurantId,
          onEvent: handleEvent,
          onConnection: setConnection,
        });
        if (disposed) transport.cleanup();
        else realtimeCleanup = transport.cleanup;
      }).catch(() => {
        if (!disposed) setConnection('offline');
      });
    }

    return () => {
      disposed = true;
      handleEventRef.current = () => undefined;
      broadcastRef.current = null;
      removeTypingListener();
      document.removeEventListener('visibilitychange', handleVisibility);
      unsubscribeBroadcast();
      realtimeCleanup?.();
      broadcast.cleanup();
      scheduler.dispose();
    };
  }, [mode, restaurantId, router]);

  useEffect(() => {
    if (!revisionNonce || revisionNonce === lastSeenNonce.current) return;
    lastSeenNonce.current = revisionNonce;
    broadcastRef.current?.post({scope: 'restaurant', nonce: revisionNonce});
    handleEventRef.current({scope: 'restaurant', source: 'local', at: Date.now()});
  }, [revisionNonce]);

  return null;
}
