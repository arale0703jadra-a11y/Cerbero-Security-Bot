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
