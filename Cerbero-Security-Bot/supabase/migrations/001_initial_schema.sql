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
       and sc.processing_at < now() - interval '2 minutes'
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
  return next claimed;
end;
$$;
