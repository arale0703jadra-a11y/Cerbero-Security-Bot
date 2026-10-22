begin;

-- Depends on migrations 001, 006, and 010. Groups are not published unless
-- an operator explicitly enables them in this service-role-only allowlist.
create table if not exists public.afrodita_verified_catalog_groups (
  group_id bigint primary key
    references public.groups(chat_id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.afrodita_verified_catalog_groups enable row level security;
revoke all privileges on table public.afrodita_verified_catalog_groups
  from public, anon, authenticated;
grant all privileges on table public.afrodita_verified_catalog_groups
  to service_role;
drop policy if exists afrodita_verified_catalog_groups_service_role_access
  on public.afrodita_verified_catalog_groups;
create policy afrodita_verified_catalog_groups_service_role_access
  on public.afrodita_verified_catalog_groups
  for all to service_role using (true) with check (true);

create or replace function public.get_afrodita_verified_catalog(
  p_group_id bigint
)
returns table (
  group_id bigint,
  user_id bigint,
  username text,
  display_name text
)
language sql
stable
security definer
set search_path = pg_catalog, public
set row_security = off
as $$
  select verified.group_id, verified.user_id, verified.username, verified.display_name
  from public.afrodita_verified_catalog_groups as catalog_access
  join public.groups as group_record
    on group_record.chat_id = catalog_access.group_id
   and group_record.active = true
  join public.verified_users as verified
    on verified.group_id = group_record.chat_id
  where p_group_id is not null
    and catalog_access.group_id = p_group_id
    and catalog_access.enabled = true
    and verified.verified = true
    and verified.revoked_at is null
  order by verified.display_name nulls last, verified.user_id
  limit 500;
$$;

revoke all privileges on function public.get_afrodita_verified_catalog(bigint)
  from public, anon, authenticated;
grant execute on function public.get_afrodita_verified_catalog(bigint)
  to anon;

commit;
