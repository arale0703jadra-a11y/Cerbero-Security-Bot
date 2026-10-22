import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VERIFIED_USER_PERMISSIONS,
  getVerifiedUser,
  normalizeVerifiedUserPermissions,
} from "../dist/database/repositories/verified-users-repository.js";
import {
  getVerifiedMessageRestriction,
  shouldSkipOrdinarySpamViolation,
} from "../dist/security/verified-user-policy.js";

function createDatabase(permissions) {
  const row = {
    id: "verified-1",
    group_id: -100123,
    user_id: 42,
    username: "sample",
    display_name: "Sample",
    verified: true,
    permissions,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: 1,
    revoked_at: null,
  };
  const query = {
    select() { return query; },
    eq() { return query; },
    is() { return query; },
    async maybeSingle() { return { data: row, error: null }; },
  };
  return { from: () => query };
}

test("complete verified permissions are preserved", () => {
  const permissions = {
    ...DEFAULT_VERIFIED_USER_PERMISSIONS,
    can_post: false,
    bypass_antispam: true,
    bypass_automatic_deletion: true,
  };
  assert.deepEqual(normalizeVerifiedUserPermissions(permissions), permissions);
});

test("partial verified permissions receive canonical defaults without losing explicit false", () => {
  assert.deepEqual(
    normalizeVerifiedUserPermissions({
      can_post: false,
      bypass_antispam: true,
      bypass_promotion_filter: false,
    }),
    {
      can_post: false,
      can_send_media: true,
      can_send_links: true,
      bypass_antispam: true,
      bypass_promotion_filter: false,
      bypass_illegal_filter: false,
      bypass_automatic_deletion: false,
    },
  );
});

test("empty and null JSONB permission values use canonical defaults", () => {
  assert.deepEqual(normalizeVerifiedUserPermissions({}), DEFAULT_VERIFIED_USER_PERMISSIONS);
  assert.deepEqual(normalizeVerifiedUserPermissions(null), DEFAULT_VERIFIED_USER_PERMISSIONS);
});

test("repository normalizes JSONB before moderation and posting decisions", async () => {
  const record = await getVerifiedUser(
    createDatabase({ can_post: false, bypass_antispam: false }),
    -100123,
    42,
  );
  assert.ok(record);
  assert.deepEqual(record.permissions, {
    can_post: false,
    can_send_media: true,
    can_send_links: true,
    bypass_antispam: false,
    bypass_promotion_filter: false,
    bypass_illegal_filter: false,
    bypass_automatic_deletion: false,
  });
  assert.equal(
    getVerifiedMessageRestriction(record.permissions, false),
    "posting_disabled",
  );
  assert.equal(
    getVerifiedMessageRestriction(record.permissions, true),
    "posting_disabled",
  );
  assert.equal(shouldSkipOrdinarySpamViolation(
    record.permissions.bypass_antispam,
    "spam_repeated",
  ), false);
});

test("explicit true and false values keep their moderation meaning", () => {
  const permissions = normalizeVerifiedUserPermissions({
    can_post: true,
    can_send_media: false,
    bypass_antispam: true,
    bypass_promotion_filter: false,
    bypass_illegal_filter: true,
    bypass_automatic_deletion: false,
  });
  assert.equal(getVerifiedMessageRestriction(permissions, true), "media_disabled");
  assert.equal(shouldSkipOrdinarySpamViolation(permissions.bypass_antispam, "spam_repeated"), true);
  assert.equal(shouldSkipOrdinarySpamViolation(permissions.bypass_antispam, "prohibited_word"), false);
  assert.equal(permissions.bypass_promotion_filter, false);
  assert.equal(permissions.bypass_illegal_filter, true);
  assert.equal(permissions.bypass_automatic_deletion, false);
});
