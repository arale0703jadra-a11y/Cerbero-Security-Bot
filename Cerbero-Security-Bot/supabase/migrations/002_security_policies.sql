create table if not exists security_group_configs (
  group_id bigint primary key references groups(chat_id) on delete cascade,
  enabled boolean not null default true,
  safe_mode boolean not null default false,
  sanctions_enabled boolean not null default true,
  mode text not null default 'alert',
  anti_spam boolean not null default true,
  anti_flood boolean not null default true,
  anti_links boolean not null default true,
  anti_content boolean not null default true,
  media_protection boolean not null default true,
  prohibited_words jsonb not null default '[]'::jsonb,
  allowed_link_domains jsonb not null default '[]'::jsonb,
  warning_two_action text not null default 'mute',
  warning_three_action text not null default 'kick',
  warning_four_action text not null default 'ban',
  reincidence_enabled boolean not null default true,
  rules jsonb not null default '{}'::jsonb,
  sticker_limit integer not null default 5,
  media_limit integer not null default 8,
  updated_at timestamptz not null default now(),
  constraint security_group_configs_mode_check check (mode in ('alert', 'automatic')),
  constraint security_group_configs_action_check check (
    warning_two_action in ('delete', 'mute', 'kick', 'ban')
    and warning_three_action in ('kick', 'ban')
    and warning_four_action in ('ban')
  )
);

alter table security_group_configs
  add column if not exists safe_mode boolean not null default false,
  add column if not exists sanctions_enabled boolean not null default true,
  add column if not exists prohibited_words jsonb not null default '[]'::jsonb,
  add column if not exists allowed_link_domains jsonb not null default '[]'::jsonb,
  add column if not exists warning_two_action text not null default 'mute',
  add column if not exists warning_three_action text not null default 'kick',
  add column if not exists warning_four_action text not null default 'ban',
  add column if not exists reincidence_enabled boolean not null default true,
  add column if not exists rules jsonb not null default '{}'::jsonb,
  add column if not exists sticker_limit integer not null default 5,
  add column if not exists media_limit integer not null default 8;

alter table bots add column if not exists version text not null default '1.0.0';

create table if not exists security_sanctions (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null references groups(chat_id) on delete cascade,
  user_id bigint not null,
  action text not null,
  reason text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index if not exists security_sanctions_lookup_idx
  on security_sanctions(group_id, user_id, active);

create table if not exists security_protected_users (
  group_id bigint not null references groups(chat_id) on delete cascade,
  user_id bigint not null,
  reason text not null default 'verified',
  protection_type text not null default 'vip',
  username text,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

alter table security_protected_users
  add column if not exists protection_type text not null default 'vip',
  add column if not exists username text;

alter table security_events
  add column if not exists group_title text,
  add column if not exists username text,
  add column if not exists message_id bigint,
  add column if not exists severity text,
  add column if not exists action text,
  add column if not exists result text,
  add column if not exists error text,
  add column if not exists executor text;

alter table security_commands
  add column if not exists attempts integer not null default 0,
  add column if not exists last_error text,
  add column if not exists responsible_bot text,
  add column if not exists cancelled_at timestamptz;
alter table security_commands
  drop constraint if exists security_commands_action_check;
alter table security_commands
  drop constraint if exists security_commands_status_check;
alter table security_commands
  add constraint security_commands_status_check
  check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled'));
alter table security_commands
  add constraint security_commands_action_check check (
    action in (
      'DELETE_MESSAGE', 'MUTE_USER', 'UNMUTE_USER', 'BAN_USER',
      'UNBAN_USER', 'KICK_USER', 'UPDATE_SECURITY_CONFIG'
      , 'UPDATE_PROTECTED_USER'
    )
  );
