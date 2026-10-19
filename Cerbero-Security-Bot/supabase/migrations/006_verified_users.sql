create table if not exists verified_users (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null references groups(chat_id) on delete cascade,
  user_id bigint not null,
  username text,
  display_name text,
  verified boolean not null default true,
  permissions jsonb not null default '{
    "can_post": true,
    "can_send_media": true,
    "can_send_links": true,
    "bypass_antispam": true,
    "bypass_promotion_filter": true,
    "bypass_illegal_filter": false,
    "bypass_automatic_deletion": false
  }'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by bigint,
  revoked_at timestamptz
);

create unique index if not exists verified_users_active_identity_idx
  on verified_users(group_id, user_id)
  where revoked_at is null;

create index if not exists verified_users_group_lookup_idx
  on verified_users(group_id, verified, revoked_at);
