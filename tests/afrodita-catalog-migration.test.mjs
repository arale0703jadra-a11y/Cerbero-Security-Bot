import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../supabase/migrations/012_afrodita_verified_catalog_read.sql",
  import.meta.url,
);
const validityMigrationUrl = new URL(
  "../supabase/migrations/013_afrodita_verified_catalog_validity.sql",
  import.meta.url,
);

test("AFRODITA catalog RPC is opt-in, read-only, and returns only public identity fields", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /create table if not exists public\.afrodita_verified_catalog_groups/i);
  assert.match(sql, /enabled boolean not null default false/i);
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /revoke all privileges on table public\.afrodita_verified_catalog_groups[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /returns table \([\s\S]*group_id bigint,[\s\S]*user_id bigint,[\s\S]*username text,[\s\S]*display_name text/i);
  assert.doesNotMatch(sql, /permissions|file_id|media/i);
  assert.match(sql, /verified\.verified = true[\s\S]*verified\.revoked_at is null/i);
  assert.match(sql, /group_record\.active = true[\s\S]*catalog_access\.enabled = true/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public[\s\S]*set row_security = off/i);
  assert.match(sql, /revoke all privileges on function public\.get_afrodita_verified_catalog\(bigint\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_afrodita_verified_catalog\(bigint\)[\s\S]*to anon/i);
});

test("AFRODITA catalog validity migration excludes expired verifications safely", async () => {
  const sql = await readFile(validityMigrationUrl, "utf8");
  assert.match(sql, /alter table public\.verified_users\s+add column if not exists valid_until timestamptz/i);
  assert.match(sql, /validity_type is distinct from 'timestamp with time zone'[\s\S]*raise exception/i);
  assert.match(sql, /returns table \([\s\S]*group_id bigint,[\s\S]*user_id bigint,[\s\S]*username text,[\s\S]*display_name text/i);
  assert.match(sql, /verified\.verified = true[\s\S]*verified\.revoked_at is null[\s\S]*verified\.valid_until is null[\s\S]*isfinite\(verified\.valid_until\)[\s\S]*verified\.valid_until > now\(\)/i);
  assert.match(sql, /group_record\.active = true[\s\S]*catalog_access\.group_id = p_group_id[\s\S]*catalog_access\.enabled = true/i);
  assert.match(sql, /verified\.group_id = group_record\.chat_id/i);
  assert.match(sql, /security definer[\s\S]*set search_path = pg_catalog, public[\s\S]*set row_security = off/i);
  assert.match(sql, /revoke all privileges on function public\.get_afrodita_verified_catalog\(bigint\)[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.get_afrodita_verified_catalog\(bigint\)[\s\S]*to anon/i);
  assert.doesNotMatch(sql, /permissions|file_id|media/i);
});
