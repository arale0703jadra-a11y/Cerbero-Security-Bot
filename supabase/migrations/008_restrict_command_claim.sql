begin;

revoke all on function public.claim_security_command(text)
  from public, anon, authenticated;

grant execute on function public.claim_security_command(text)
  to service_role;

commit;
