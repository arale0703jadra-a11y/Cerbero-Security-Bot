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
    left join bots previous on previous.instance_id = sc.processing_instance_id
      and previous.name = 'Cerbero'
      and previous.type = 'security'
  where (
       sc.status = 'pending'
       or (
         sc.status = 'processing'
         and sc.lease_expires_at is not null
         and sc.lease_expires_at < now()
         and previous.id is not null
         and previous.last_heartbeat_at is not null
         and previous.last_heartbeat_at < now() - interval '2 minutes'
       )
     )
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
