-- Storage RLS policies: https://supabase.com/docs/guides/storage/security/access-control
insert into storage.buckets(id,name,public) values
  ('recordings','recordings',false), ('audio-cache','audio-cache',false)
on conflict(id) do update set public=false;

grant usage on schema storage to authenticated;
grant select on storage.objects to authenticated;
create policy recordings_tenant_read on storage.objects for select to authenticated
using (
  bucket_id='recordings' and
  case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (storage.foldername(name))[1]::uuid in (select private.user_restaurant_ids()) else false end
);
create policy audio_cache_tenant_read on storage.objects for select to authenticated
using (
  bucket_id='audio-cache' and
  case when (storage.foldername(name))[1] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then (storage.foldername(name))[1]::uuid in (select private.user_restaurant_ids()) else false end
);

-- Postgres Changes publication setup: https://supabase.com/docs/guides/realtime/postgres-changes
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='calls'
  ) then alter publication supabase_realtime add table public.calls; end if;
end $$;
