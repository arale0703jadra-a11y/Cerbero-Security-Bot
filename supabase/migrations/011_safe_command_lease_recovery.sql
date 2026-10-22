begin;

alter table public.security_commands
  add column if not exists execution_started_at timestamptz;

-- Existing workers cannot prove whether an external action already began.
-- Treat their claims conservatively so the new recovery path never replays them.
update public.security_commands
   set execution_started_at = coalesce(processing_at, created_at, now())
 where status = 'processing'
   and result_state = 'processing'
   and execution_started_at is null;

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
  max_attempts constant integer := 5;
begin
  -- A worker may have completed an external call before its lease expired. Never
  -- replay such a command automatically; preserve it for explicit reconciliation.
  update public.security_commands sc
     set result_state = 'unknown',
         last_error = concat_ws(
           '; ',
           'Lease expired after execution started; inspect the target state and reconcile manually.',
           sc.last_error
         ),
         processing_instance_id = null,
         processing_token = null,
         processing_at = null,
         lease_expires_at = null
   where sc.status = 'processing'
     and sc.result_state = 'processing'
     and sc.lease_expires_at <= now()
     and sc.execution_started_at is not null;

  -- Stop retrying safely recoverable commands once their bounded claim count is spent.
  update public.security_commands sc
     set status = 'failed',
         result_state = 'failed',
         executed_at = now(),
         last_error = 'Command lease attempt limit exceeded before execution started.',
         processing_instance_id = null,
         processing_token = null,
         processing_at = null,
         lease_expires_at = null
   where sc.attempts >= max_attempts
     and (
       sc.status = 'pending'
       or (
         sc.status = 'processing'
         and sc.result_state = 'processing'
         and sc.lease_expires_at <= now()
         and sc.execution_started_at is null
       )
     );

  select sc.*
    into claimed
    from public.security_commands sc
    join public.groups g on g.chat_id = sc.group_id and g.active = true
    join public.group_bot_bindings gb on gb.group_id = sc.group_id and gb.enabled = true
    join public.bots claimant on claimant.id = gb.bot_id
      and claimant.name = 'Cerbero'
      and claimant.type = 'security'
      and claimant.instance_id = p_instance_id
   where sc.attempts < max_attempts
     and (
       sc.status = 'pending'
       or (
         sc.status = 'processing'
         and sc.result_state = 'processing'
         and sc.lease_expires_at <= now()
         and sc.execution_started_at is null
       )
     )
   order by sc.created_at
   limit 1
   for update of sc skip locked;

  if not found then
    return;
  end if;

  update public.security_commands
     set status = 'processing',
         result_state = 'processing',
         processing_instance_id = p_instance_id,
         processing_token = new_token,
         lease_expires_at = new_lease,
         processing_at = now(),
         execution_started_at = null,
         attempts = coalesce(attempts, 0) + 1,
         responsible_bot = 'Cerbero'
   where id = claimed.id;

  claimed.status := 'processing';
  claimed.result_state := 'processing';
  claimed.processing_instance_id := p_instance_id;
  claimed.processing_token := new_token;
  claimed.lease_expires_at := new_lease;
  claimed.processing_at := now();
  claimed.execution_started_at := null;
  claimed.attempts := coalesce(claimed.attempts, 0) + 1;
  claimed.responsible_bot := 'Cerbero';
  return next claimed;
end;
$$;

revoke all on function public.claim_security_command(text)
  from public, anon, authenticated;
grant execute on function public.claim_security_command(text)
  to service_role;

commit;
