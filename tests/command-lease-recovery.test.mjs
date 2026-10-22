import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

const migrationDirectory = new URL("../supabase/migrations/", import.meta.url);
const migrationPath = new URL(
  "../supabase/migrations/011_safe_command_lease_recovery.sql",
  import.meta.url,
);

test("the recovery migration is included in the numbered migration chain", async () => {
  const files = await readdir(migrationDirectory);
  const numbered = files.filter((file) => /^\d{3}_.*\.sql$/.test(file)).sort();
  assert.ok(numbered.includes("011_safe_command_lease_recovery.sql"));
  assert.ok(numbered.includes("010_lock_down_security_data_api.sql"));
});

test("stale claims are atomically reclaimed only before execution starts", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /update public\.security_commands[\s\S]*?set execution_started_at = coalesce\(processing_at, created_at, now\(\)\)[\s\S]*?where status = 'processing'[\s\S]*?result_state = 'processing'[\s\S]*?execution_started_at is null/i);
  assert.match(sql, /sc\.status = 'processing'[\s\S]*?sc\.lease_expires_at <= now\(\)[\s\S]*?sc\.execution_started_at is null/);
  assert.match(sql, /for update of sc skip locked/i);
  assert.match(sql, /processing_token = new_token/);
  assert.match(sql, /new_token uuid := gen_random_uuid\(\)/);
});

test("expired executing commands become unknown for manual reconciliation, never auto-replayed", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /result_state = 'unknown'/);
  assert.match(sql, /sc\.execution_started_at is not null/);
  assert.match(sql, /reconcile manually/i);
  assert.match(sql, /result_state = 'processing'[\s\S]*?sc\.execution_started_at is null/);
});

test("claim attempts are capped and exhausted unstarted commands fail closed", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /max_attempts constant integer := 5/);
  assert.match(sql, /sc\.attempts >= max_attempts/);
  assert.match(sql, /sc\.attempts < max_attempts/);
  assert.match(sql, /status = 'failed'[\s\S]*?result_state = 'failed'/);
});
