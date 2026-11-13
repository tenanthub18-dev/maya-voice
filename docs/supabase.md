# Supabase database workflow

The database schema is managed only by the timestamped SQL files in
`supabase/migrations/`. Supabase documents the local workflow and CLI commands at
<https://supabase.com/docs/guides/local-development/overview>.

## Create the hosted project

Create the project in **Canada (Central), `ca-central-1`**. The region is chosen
when the project is created; `supabase/config.toml` does not select the hosted
region. The current region list is maintained at
<https://supabase.com/docs/guides/platform/regions>.

Keep the project reference (the short identifier in the project URL) available,
but never commit access tokens, database passwords, publishable keys, or secret
keys. Authenticate the CLI interactively or through the operator's secret store;
do not paste credentials into this repository or command history.

## Run locally

Install Docker and Supabase CLI, then run from the repository root:

```sh
supabase start
supabase db reset
```

`db reset` recreates the local database, applies every migration in timestamp
order, and loads `supabase/seed.sql`. Inspect local status with:

```sh
supabase status
```

Supabase's CLI reference is at <https://supabase.com/docs/reference/cli/introduction>.

## Link and push to Canada Central

Confirm in the Supabase dashboard that the target project is the intended
`ca-central-1` project. Then link its project reference and review the pending
migrations before applying them:

```sh
supabase link --project-ref <project-ref>
supabase migration list
supabase db push --dry-run
supabase db push
```

The link and push workflow is documented at
<https://supabase.com/docs/guides/deployment/database-migrations>. `db push`
applies migrations that are not yet recorded in the remote migration history.
It does not change the project's region.

Do not run the seed against production as part of `db push`; the seed contains
demo restaurants for local development. For a migration already merged or
applied remotely, create a new timestamped migration rather than editing the
existing file.
