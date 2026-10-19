begin;

-- Apply after APPLY_ALL_001_TO_007.sql or migration 007.
alter table public.security_commands
  add column if not exists operation_key text,
  add column if not exists result_state text;

update public.security_commands
set result_state = case status
  when 'pending' then 'queued'
  when 'processing' then
    case
      when lease_expires_at is null or lease_expires_at < now() then 'unknown'
      else 'processing'
    end
  when 'completed' then 'completed'
  when 'failed' then 'failed'
  when 'cancelled' then 'cancelled'
  else 'unknown'
end
where result_state is null;

alter table public.security_commands
  alter column result_state set default 'unknown',
  alter column result_state set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'security_commands_result_state_check'
      and conrelid = 'public.security_commands'::regclass
  ) then
    alter table public.security_commands
      add constraint security_commands_result_state_check
      check (
        result_state in (
          'queued',
          'processing',
          'completed',
          'failed',
          'cancelled',
          'unknown'
        )
      );
  end if;
end;
$$;

create unique index if not exists security_commands_operation_key_idx
  on public.security_commands(group_id, action, operation_key)
  where operation_key is not null;

create or replace function public.claim_security_command(p_instance_id text)
returns setof public.security_commands
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.security_commands;
  new_token uuid := gen_random_uuid();
  new_lease timestamptz := now() + interval '90 seconds';
begin
  select sc.*
    into claimed
    from public.security_commands sc
    join public.groups g on g.chat_id = sc.group_id and g.active = true
    join public.group_bot_bindings gb on gb.group_id = sc.group_id and gb.enabled = true
    join public.bots claimant on claimant.id = gb.bot_id
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

  update public.security_commands
    set status = 'processing',
        processing_instance_id = p_instance_id,
        processing_token = new_token,
        lease_expires_at = new_lease,
        processing_at = now(),
        attempts = attempts + 1,
        responsible_bot = 'Cerbero',
        result_state = 'processing'
  where id = claimed.id;

  claimed.status := 'processing';
  claimed.processing_instance_id := p_instance_id;
  claimed.processing_token := new_token;
  claimed.lease_expires_at := new_lease;
  claimed.processing_at := now();
  claimed.attempts := claimed.attempts + 1;
  claimed.result_state := 'processing';
  return next claimed;
end;
$$;

revoke all on function public.claim_security_command(text)
  from public, anon, authenticated;

grant execute on function public.claim_security_command(text)
  to service_role;

commit;
