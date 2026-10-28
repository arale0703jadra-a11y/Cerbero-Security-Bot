import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(
  join(pkgRoot, "..", "_security-remediation-prep-20261022", "09_CLAIM_RECONCILIATION_draft.sql"),
  "utf8",
);

test("el draft conserva las garantias actuales de concurrencia y fencing", () => {
  assert.match(sql, /for update of sc skip locked/i);
  assert.match(sql, /new_token uuid := gen_random_uuid\(\)/);
  assert.match(sql, /new_lease timestamptz := now\(\) \+ interval '90 seconds'/);
  assert.match(sql, /responsible_bot = 'Cerbero'/);
  assert.match(sql, /claimant\.instance_id = p_instance_id/);
});

test("el draft incorpora la proteccion 011 contra replay y el limite de intentos", () => {
  assert.match(sql, /execution_started_at/);
  assert.match(sql, /max_attempts constant integer := 5/);
  assert.match(sql, /result_state = 'unknown'/);
  assert.match(sql, /Lease expired after execution started/);
  assert.match(sql, /Command lease attempt limit exceeded before execution started\./);
});

test("el draft conserva el heartbeat de instancia como condicion de reclamo", () => {
  assert.match(sql, /previous\.last_heartbeat_at < now\(\) - interval '2 minutes'/);
});

test("el draft incluye idempotencia de 009 y mantiene R1", () => {
  assert.match(sql, /add column if not exists operation_key/);
  assert.match(sql, /add column if not exists result_state/);
  assert.match(sql, /create unique index if not exists security_commands_operation_key_idx/);
  assert.match(sql, /revoke all on function public\.claim_security_command\(text\)\s+from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.claim_security_command\(text\)\s+to service_role/i);
});

test("el draft es transaccional e idempotente", () => {
  assert.match(sql, /^begin;$/m);
  assert.match(sql, /^commit;$/m);
  assert.doesNotMatch(sql, /drop table|truncate|delete from/i);
});