# Realtime "live call" banner options
Sources: https://supabase.com/docs/guides/realtime/postgres-changes , /broadcast , /authorization

## A. postgres_changes (verbatim pattern from docs, table/filter adapted)
```js
const changes = supabase
  .channel('table-filter-changes')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'todos', filter: 'id=eq.1' }, (payload) => console.log(payload))
  .subscribe()
```
Enable: `alter publication supabase_realtime add table your_table_name;` RLS applies to events; DELETE events are not RLS-filtered; DELETE filtering/old values need `alter table t replica identity full;`. Payload fields NOT documented on that page (UNVERIFIED).

## B. Private broadcast channel (docs-recommended for authorization)
`supabase.channel('topic', { config: { private: true } })`; policies on `realtime.messages` (select = receive, insert = send) using `realtime.topic()`, `realtime.messages.extension`, `auth.uid()`. Do NOT run `ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY` (fails 42501). Policies cached until JWT expiry/new JWT. Full policy SQL not captured (UNVERIFIED).
DB-side: `realtime.send(payload, event, topic, private)` and `realtime.broadcast_changes(topic, event, operation, table, schema, new, old)` in a trigger (SQL in broadcast page).
Send via HTTP before subscribe; WebSocket after `subscribe((status)=>status==='SUBSCRIBED')`.
