-- Auth and RLS patterns: https://supabase.com/docs/guides/database/postgres/row-level-security
create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  inviter_user_id uuid not null references auth.users(id) on delete cascade,
  email text not null check (email = lower(trim(email)) and length(email) > 3),
  role text not null check (role in ('owner', 'staff')),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  check (expires_at > created_at),
  check ((accepted_at is null and accepted_by is null) or (accepted_at is not null and accepted_by is not null))
);

create trigger set_organization_invitations_updated_at
before update on public.organization_invitations
for each row execute function private.set_updated_at();

create index organization_invitations_organization_id_idx on public.organization_invitations(organization_id);
create index organization_invitations_email_idx on public.organization_invitations(email);

alter table public.organization_invitations enable row level security;
grant select, insert, update, delete on public.organization_invitations to authenticated;

create policy organization_invitations_owner_all on public.organization_invitations
for all to authenticated
using (organization_id in (select private.user_owned_organization_ids()))
with check (
  organization_id in (select private.user_owned_organization_ids())
  and inviter_user_id = (select auth.uid())
);

create policy organization_invitations_invitee_select on public.organization_invitations
for select to authenticated
using (email = lower(coalesce((select auth.jwt()) ->> 'email', '')));

create or replace function public.accept_organization_invitation(p_invitation_id uuid)
returns table (organization_id uuid, role text)
language plpgsql security definer set search_path = '' as $$
declare
  accepted public.organization_invitations;
  signed_in_email text := lower(coalesce((select auth.jwt()) ->> 'email', ''));
begin
  if (select auth.uid()) is null or signed_in_email = '' then
    raise exception 'authentication required';
  end if;

  update public.organization_invitations
  set accepted_at = now(), accepted_by = (select auth.uid())
  where id = p_invitation_id
    and accepted_at is null
    and expires_at > now()
    and email = signed_in_email
  returning * into accepted;

  if accepted.id is null then
    raise exception 'invitation is invalid, expired, or already used';
  end if;

  insert into public.memberships (user_id, organization_id, role)
  values ((select auth.uid()), accepted.organization_id, accepted.role)
  on conflict (organization_id, user_id) do nothing;

  return query
  select membership.organization_id, membership.role
  from public.memberships as membership
  where membership.organization_id = accepted.organization_id
    and membership.user_id = (select auth.uid());
end;
$$;

revoke all on function public.accept_organization_invitation(uuid) from public, anon;
grant execute on function public.accept_organization_invitation(uuid) to authenticated;
