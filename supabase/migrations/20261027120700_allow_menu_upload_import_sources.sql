alter table public.import_jobs drop constraint import_jobs_source_url_check;
alter table public.import_jobs add constraint import_jobs_source_url_check
  check (source_url ~ '^https?://' or source_url ~ '^upload://menu/');
