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
