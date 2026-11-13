# Web data ownership

The server `DataSource` is the only owner of business data. Client components receive render props and hold no mirrored restaurant, agent, booking, order, or settings copies.

## Product identity

`apps/web/lib/brand.ts` owns the localized product name and default persona name. Product, restaurant, and persona names are distinct concepts. Server components call `getProductName(locale)` and pass the result to client components.

## Restaurant identity

`apps/web/lib/restaurant.ts` exposes `getCurrentRestaurant()`. React `cache` deduplicates reads during Server Component render work; route handlers and actions use the same accessor for consistent ownership without a client store.

## Write invalidation

Business-data actions call `invalidateAfterWrite()` after successful mutations that can change rendered shared data. It invalidates the root layout and rotates the `live-rev` cookie so all routes re-read the server. Brief 032 consumes that cookie for live client refresh.

## Adding an entity

1. Add the entity contract and operations to `DataSource`.
2. Implement those operations in the server-backed and mock data sources.
3. Read the entity directly from the server data source; pass only render props to clients.
4. Call `invalidateAfterWrite()` in every action that mutates it.
5. Add contract and invalidation tests before implementation.

## Live sync

The client stores signals only; rendered entities still come from the server `DataSource`.

```text
server write -> live-rev cookie -> originating tab -> BroadcastChannel -> other tabs
Supabase Postgres Changes -------------------------------> any signed-in device
                                      signal -> coalescer -> router.refresh()
                                                         -> Server Components -> DataSource
```

Every received broadcast records its nonce before refreshing. When the refreshed layout receives that same nonce, it does not broadcast it again; this prevents tab-to-tab ping-pong. Route scopes avoid unrelated refreshes, hidden tabs queue one refresh, and remote refreshes wait while a user is typing in a form control inside `main`.

In-tab signal delivery is synchronous and tested at less than 50 ms for 1,000 events across 50 subscribers, supporting the sub-millisecond per-update guarantee. Same-browser cross-tab delivery is normally on the order of milliseconds through `BroadcastChannel`; cross-device delivery is bounded by Supabase Realtime and the network. The application does not claim sub-millisecond network latency or immediate cross-device consistency.
