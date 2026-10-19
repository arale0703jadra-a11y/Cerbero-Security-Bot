-- MIGRATION 001
create extension if not exists pgcrypto;

create table if not exists bots (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  type text not null,
  status text not null default 'offline',
  instance_id text not null unique,
  version text not null default '1.0.0',
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists groups (
  chat_id bigint primary key,
  title text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists group_bot_bindings (
  group_id bigint not null references groups(chat_id) on delete cascade,
  bot_id uuid not null references bots(id) on delete cascade,
  enabled boolean not null default true,
  permissions jsonb not null default '{}'::jsonb,
  primary key (group_id, bot_id)
);

alter table group_bot_bindings
  add column if not exists enabled boolean not null default true;

create table if not exists security_commands (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null references groups(chat_id) on delete cascade,
  action text not null,
  target_user_id bigint,
  target_message_id bigint,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  executed_at timestamptz,
  processing_instance_id text,
  processing_at timestamptz
);

alter table security_commands
  drop constraint if exists security_commands_status_check;

update security_commands
set status = 'completed'
where status = 'success';

alter table security_commands
  add constraint security_commands_status_check
  check (status in ('pending', 'processing', 'completed', 'failed'));

create table if not exists security_events (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null references groups(chat_id) on delete cascade,
  event_type text not null,
  user_id bigint,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists security_audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  executed_by text not null,
  result text not null,
  created_at timestamptz not null default now()
);

create index if not exists security_commands_pending_idx
  on security_commands(status, created_at);

create index if not exists security_events_group_idx
  on security_events(group_id, created_at desc);

-- MIGRATION 002
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

alter table bots
  add column if not exists version text not null default '1.0.0';

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
      'DELETE_MESSAGE',
      'MUTE_USER',
      'UNMUTE_USER',
      'BAN_USER',
      'UNBAN_USER',
      'KICK_USER',
      'UPDATE_SECURITY_CONFIG',
      'UPDATE_PROTECTED_USER'
    )
  );

-- MIGRATION 003
alter table security_events
  add column if not exists command_id uuid references security_commands(id) on delete set null,
  add column if not exists processing_instance_id text;

alter table security_audit_log
  add column if not exists command_id uuid references security_commands(id) on delete set null,
  add column if not exists group_id bigint references groups(chat_id) on delete set null,
  add column if not exists target_user_id bigint,
  add column if not exists target_message_id bigint,
  add column if not exists executor text,
  add column if not exists processing_instance_id text,
  add column if not exists error text;

alter table security_commands
  drop constraint if exists security_commands_action_check;

alter table security_commands
  add constraint security_commands_action_check check (
    action in (
      'DELETE_MESSAGE',
      'MUTE_USER',
      'UNMUTE_USER',
      'BAN_USER',
      'UNBAN_USER',
      'KICK_USER',
      'UPDATE_SECURITY_CONFIG',
      'UPDATE_PROTECTED_USER',
      'WARN_USER',
      'UNWARN_USER',
      'UNWARN_ALL',
      'CLEAN_MESSAGES'
    )
  );

create index if not exists security_events_command_idx
  on security_events(command_id, created_at desc);

create index if not exists security_audit_command_idx
  on security_audit_log(command_id, created_at desc);

-- MIGRATION 004
create table if not exists security_warnings (
  id uuid primary key default gen_random_uuid(),
  group_id bigint not null references groups(chat_id) on delete cascade,
  user_id bigint not null,
  requester_id bigint,
  requester_name text,
  reason text not null,
  command_id uuid references security_commands(id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists security_warnings_active_idx
  on security_warnings(group_id, user_id, revoked_at, created_at desc);

-- MIGRATION 005
alter table security_events
  add column if not exists reason text;

alter table security_audit_log
  add column if not exists reason text;

create index if not exists security_warnings_command_idx
  on security_warnings(command_id)
  where command_id is not null;

create or replace function claim_security_command(p_instance_id text)
returns setof security_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed security_commands;
begin
  select sc.*
    into claimed
    from security_commands sc
    join groups g on g.chat_id = sc.group_id and g.active = true
    join group_bot_bindings gb on gb.group_id = sc.group_id and gb.enabled = true
    join bots b on b.id = gb.bot_id
  where (
       sc.status = 'pending'
       or (
         sc.status = 'processing'
         and sc.processing_at < now() - interval '10 minutes'
         and coalesce(b.last_heartbeat_at, to_timestamp(0)) < now() - interval '2 minutes'
       )
     )
    and b.name = 'Cerbero'
    and b.instance_id = p_instance_id
  order by sc.created_at
  limit 1
  for update of sc skip locked;

  if not found then
    return;
  end if;

  update security_commands
    set status = 'processing',
        processing_instance_id = p_instance_id,
        processing_at = now(),
        attempts = attempts + 1,
        responsible_bot = 'Cerbero'
  where id = claimed.id;

  claimed.status := 'processing';
  claimed.processing_instance_id := p_instance_id;
  claimed.processing_at := now();
  claimed.attempts := claimed.attempts + 1;

  return next claimed;
end;
$$;

-- MIGRATION 006
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

-- MIGRATION 007
alter table security_commands
  add column if not exists processing_token uuid,
  add column if not exists lease_expires_at timestamptz;

alter table security_audit_log
  add column if not exists command_id uuid references security_commands(id) on delete set null,
  add column if not exists group_id bigint references groups(chat_id) on delete set null,
  add column if not exists target_user_id bigint,
  add column if not exists target_message_id bigint,
  add column if not exists processing_instance_id text,
  add column if not exists executed_by text,
  add column if not exists action text,
  add column if not exists result text,
  add column if not exists error text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists security_commands_lease_idx
  on security_commands(status, lease_expires_at);

create index if not exists security_audit_command_trace_idx
  on security_audit_log(command_id, created_at desc);

create or replace function claim_security_command(p_instance_id text)
returns setof security_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed security_commands;
  new_token uuid := gen_random_uuid();
  new_lease timestamptz := now() + interval '90 seconds';
begin
  select sc.*
    into claimed
    from security_commands sc
    join groups g on g.chat_id = sc.group_id and g.active = true
    join group_bot_bindings gb on gb.group_id = sc.group_id and gb.enabled = true
    join bots claimant on claimant.id = gb.bot_id
      and claimant.name = 'Cerbero'
      and claimant.type = 'security'
      and claimant.instance_id = p_instance_id
  where sc.status = 'pending'
  order by sc.created_at
  limit 1
  for update of sc skip locked;

  if not found then
    return;
  end if;

  update security_commands
    set status = 'processing',
        processing_instance_id = p_instance_id,
        processing_token = new_token,
        lease_expires_at = new_lease,
        processing_at = now(),
        attempts = attempts + 1,
        responsible_bot = 'Cerbero'
  where id = claimed.id;

  claimed.status := 'processing';
  claimed.processing_instance_id := p_instance_id;
  claimed.processing_token := new_token;
  claimed.lease_expires_at := new_lease;
  claimed.processing_at := now();
  claimed.attempts := claimed.attempts + 1;

  return next claimed;
end;
$$;