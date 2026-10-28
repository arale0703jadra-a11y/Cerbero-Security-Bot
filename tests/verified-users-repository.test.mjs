import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_VERIFIED_USER_PERMISSIONS,
  getVerifiedUser,
  getVerifiedUserPermissions,
  normalizeVerifiedUserPermissions,
} from "../dist/database/repositories/verified-users-repository.js";
import {
  getVerifiedMessageRestriction,
  shouldSkipOrdinarySpamViolation,
} from "../dist/security/verified-user-policy.js";

function createRow(permissions, overrides = {}) {
  return {
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
    ...overrides,
  };
}

function createDatabase(row, error = null) {
  const filters = [];
  const query = {
    select() { return query; },
    eq(column, value) { filters.push([column, "eq", value]); return query; },
    is(column, value) { filters.push([column, "is", value]); return query; },
    async maybeSingle() {
      if (error) return { data: null, error };
      const matches = filters.every(([column, operator, value]) =>
        operator === "eq"
          ? row[column] === value
          : row[column] === null || row[column] === undefined,
      );
      return { data: matches ? row : null, error: null };
    },
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
    createDatabase(createRow({ can_post: false, bypass_antispam: false })),
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

test("a future verified record is active at the injected instant", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  const record = await getVerifiedUser(
    createDatabase(createRow({}, { valid_until: "2026-10-22T12:00:00.001Z" })),
    -100123,
    42,
    now,
  );
  assert.ok(record);
});

test("an expired record is not returned by getVerifiedUser", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  const database = () => createDatabase(createRow(
    { bypass_antispam: true },
    { valid_until: "2026-10-22T11:59:59.999Z" },
  ));
  assert.equal(
    await getVerifiedUser(database(), -100123, 42, now),
    undefined,
  );
  assert.equal(
    await getVerifiedUserPermissions(database(), -100123, 42, now),
    undefined,
  );
});

test("valid_until equal to now is inactive", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  assert.equal(
    await getVerifiedUser(
      createDatabase(createRow({}, { valid_until: now.toISOString() })),
      -100123,
      42,
      now,
    ),
    undefined,
  );
});

test("invalid validity dates are inactive and cannot return permissions", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  assert.equal(
    await getVerifiedUserPermissions(
      createDatabase(createRow(
        { bypass_antispam: true },
        { valid_until: "not-a-date" },
      )),
      -100123,
      42,
      now,
    ),
    undefined,
  );
  assert.equal(
    await getVerifiedUser(
      createDatabase(createRow({}, { valid_until: 1792670400000 })),
      -100123,
      42,
      now,
    ),
    undefined,
  );
});

test("null and absent valid_until preserve legacy verified records", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  for (const overrides of [{ valid_until: null }, {}]) {
    const record = await getVerifiedUser(
      createDatabase(createRow({}, overrides)),
      -100123,
      42,
      now,
    );
    assert.ok(record);
  }
});

test("revoked and non-verified records are inactive", async () => {
  const now = new Date("2026-10-22T12:00:00.000Z");
  assert.equal(
    await getVerifiedUser(
      createDatabase(createRow({}, { revoked_at: "2026-10-21T00:00:00.000Z" })),
      -100123,
      42,
      now,
    ),
    undefined,
  );
  assert.equal(
    await getVerifiedUser(
      createDatabase(createRow({}, { verified: false })),
      -100123,
      42,
      now,
    ),
    undefined,
  );
});

test("database errors reject instead of granting verified permissions", async () => {
  const databaseError = { code: "400", message: "query failed" };
  await assert.rejects(
    getVerifiedUserPermissions(
      createDatabase(createRow({ bypass_antispam: true }), databaseError),
      -100123,
      42,
      new Date("2026-10-22T12:00:00.000Z"),
    ),
    (error) => error === databaseError,
  );
});

test("verified user reads remain isolated by group_id and user_id", async () => {
  const record = await getVerifiedUser(
    createDatabase(createRow({}, { group_id: -100999 })),
    -100123,
    42,
    new Date("2026-10-22T12:00:00.000Z"),
  );
  assert.equal(record, undefined);
  assert.equal(
    await getVerifiedUser(
      createDatabase(createRow({}, { user_id: 43 })),
      -100123,
      42,
      new Date("2026-10-22T12:00:00.000Z"),
    ),
    undefined,
  );
});

test("active records retain only the permission values already stored", async () => {
  const permissions = {
    ...DEFAULT_VERIFIED_USER_PERMISSIONS,
    can_post: false,
    bypass_antispam: true,
    bypass_illegal_filter: true,
  };
  const result = await getVerifiedUserPermissions(
    createDatabase(createRow(permissions, {
      valid_until: "2026-10-23T00:00:00.000Z",
    })),
    -100123,
    42,
    new Date("2026-10-22T12:00:00.000Z"),
  );
  assert.deepEqual(result, permissions);
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
