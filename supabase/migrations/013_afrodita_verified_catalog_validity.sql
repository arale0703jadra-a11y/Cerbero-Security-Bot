begin;

-- Migration 012 already depends on public.verified_users. Add the expiry
-- column for older schemas; NULL keeps legacy verified records in the catalog.
alter table public.verified_users
  add column if not exists valid_until timestamptz;

do $$
declare
  validity_type text;
begin
  select format_type(attribute.atttypid, attribute.atttypmod)
    into validity_type
  from pg_attribute as attribute
  where attribute.attrelid = 'public.verified_users'::regclass
    and attribute.attname = 'valid_until'
    and not attribute.attisdropped;

  if validity_type is distinct from 'timestamp with time zone' then
    raise exception
      'public.verified_users.valid_until must be timestamp with time zone; found %',
      validity_type;
  end if;
end;
$$;

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
    and (
      verified.valid_until is null
      or (
        isfinite(verified.valid_until)
        and verified.valid_until > now()
      )
    )
  order by verified.display_name nulls last, verified.user_id
  limit 500;
$$;

revoke all privileges on function public.get_afrodita_verified_catalog(bigint)
  from public, anon, authenticated;
grant execute on function public.get_afrodita_verified_catalog(bigint)
  to anon;

commit;
