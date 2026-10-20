import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requiredRelations = [
  "bots",
  "groups",
  "group_bot_bindings",
  "security_commands",
  "security_events",
  "security_audit_log",
  "security_group_configs",
  "security_sanctions",
  "security_protected_users",
  "security_warnings",
  "verified_users",
  "system_owner",
  "system_owner_recovery_keys",
  "system_owner_recovery_attempts",
  "system_owner_recovery_challenges",
  "system_owner_audit",
  "verified_member_tag_reviews",
  "verified_member_tag_audit",
];

for (const filename of [
  "supabase/migrations/010_lock_down_security_data_api.sql",
  "supabase/migrations/APPLY_ALL_001_TO_007.sql",
]) {
  test(`${filename} restricts security relations to the backend role`, async () => {
    const sql = await readFile(resolve(root, filename), "utf8");
    for (const relation of requiredRelations) {
      assert.ok(sql.includes(`'${relation}'`), `missing relation ${relation}`);
    }
    assert.match(sql, /enable row level security/iu);
    assert.match(
      sql,
      /revoke all privileges on table public\.%I from public, anon, authenticated/iu,
    );
    assert.match(sql, /grant all privileges on table public\.%I to service_role/iu);
    assert.match(
      sql,
      /create policy %I on public\.%I for all to service_role using \(true\) with check \(true\)/iu,
    );
    assert.match(
      sql,
      /revoke all privileges on function public\.claim_security_command\(text\) from public, anon, authenticated/iu,
    );
    assert.match(
      sql,
      /grant execute on function public\.claim_security_command\(text\) to service_role/iu,
    );
    if (filename.endsWith("010_lock_down_security_data_api.sql")) {
      assert.doesNotMatch(sql, /^\s*(?:insert|update|delete)\s/imu);
    }
  });
}

test("consolidated installation closes access after creating verified_users", async () => {
  const sql = await readFile(
    resolve(root, "supabase/migrations/APPLY_ALL_001_TO_007.sql"),
    "utf8",
  );
  const lastTableCreation = sql.lastIndexOf("create table if not exists verified_users");
  const accessHardening = sql.lastIndexOf("alter table public.%I enable row level security");
  assert.ok(lastTableCreation >= 0);
  assert.ok(accessHardening > lastTableCreation);
  assert.doesNotMatch(
    sql.slice(accessHardening),
    /^\s*(?:insert|update|delete)\s/imu,
  );
});
