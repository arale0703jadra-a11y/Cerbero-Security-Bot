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
      'DELETE_MESSAGE', 'MUTE_USER', 'UNMUTE_USER', 'BAN_USER',
      'UNBAN_USER', 'KICK_USER', 'UPDATE_SECURITY_CONFIG',
      'UPDATE_PROTECTED_USER', 'WARN_USER', 'UNWARN_USER',
      'UNWARN_ALL', 'CLEAN_MESSAGES'
    )
  );

create index if not exists security_events_command_idx
  on security_events(command_id, created_at desc);

create index if not exists security_audit_command_idx
  on security_audit_log(command_id, created_at desc);
