-- Adds 'ar' (Arabic) as a eighth supported language. Widens existing checks only; no data changes.
alter table public.restaurants drop constraint restaurants_primary_language_check;
alter table public.restaurants add constraint restaurants_primary_language_check
  check (primary_language in ('en','fr-CA','ur','hi','pa','en-IN','te','ar'));

alter table public.restaurants drop constraint restaurants_check;
alter table public.restaurants add constraint restaurants_check
  check (cardinality(enabled_languages) > 0
    and enabled_languages <@ array['en','fr-CA','ur','hi','pa','en-IN','te','ar']::text[]
    and primary_language = any(enabled_languages));

alter table public.faqs drop constraint faqs_language_check;
alter table public.faqs add constraint faqs_language_check
  check (language in ('en','fr-CA','ur','hi','pa','en-IN','te','ar'));

alter table public.audio_cache drop constraint audio_cache_language_check;
alter table public.audio_cache add constraint audio_cache_language_check
  check (language in ('en','fr-CA','ur','hi','pa','en-IN','te','ar'));

alter table public.call_turns drop constraint call_turns_language_check;
alter table public.call_turns add constraint call_turns_language_check
  check (language in ('en','fr-CA','ur','hi','pa','en-IN','te','ar'));
