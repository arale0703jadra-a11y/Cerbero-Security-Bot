import assert from "node:assert/strict";
import test from "node:test";
import { detectSpam } from "../dist/anti-spam/detector.js";
import {
  getWarningCount,
  isProtectedUser,
} from "../dist/database/repositories/security-config-repository.js";
import { getSecurityConfigResilient } from "../dist/database/repositories/security-config-repository.js";
import { getVerifiedUserPermissions } from "../dist/database/repositories/verified-users-repository.js";

function makeConfigDb(responses) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    from(table) {
      assert.equal(table, "security_group_configs");
      return {
        select() {
          return {
            eq() {
              return {
                async maybeSingle() {
                  calls += 1;
                  return responses[Math.min(calls - 1, responses.length - 1)];
                },
              };
            },
          };
        },
      };
    },
  };
}

function makeReadDb(table, responses) {
  let calls = 0;
  const next = () => {
    calls += 1;
    return responses[Math.min(calls - 1, responses.length - 1)];
  };
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    is() {
      return query;
    },
    maybeSingle: async () => next(),
    then(resolve, reject) {
      return Promise.resolve(next()).then(resolve, reject);
    },
  };
  return {
    get calls() {
      return calls;
    },
    from(actualTable) {
      assert.equal(actualTable, table);
      return query;
    },
  };
}

test("security configuration read recovers after a transient Supabase failure", async () => {
  const db = makeConfigDb([
    { data: null, error: { code: "ECONNRESET", message: "connection reset" } },
    { data: { group_id: -100, anti_spam: false }, error: null },
  ]);
  const config = await getSecurityConfigResilient(db, -100, () => {});

  assert.equal(db.calls, 2);
  assert.equal(config.group_id, -100);
  assert.equal(config.anti_spam, false);
});

test("security configuration retries are bounded and fall back to detection-only mode", async () => {
  const db = makeConfigDb([
    { data: null, error: { code: "ECONNRESET", message: "connection reset" } },
  ]);
  const logs = [];
  const config = await getSecurityConfigResilient(db, -100, (message) => logs.push(message));

  assert.equal(db.calls, 3);
  assert.equal(config.enabled, true);
  assert.equal(config.safe_mode, true);
  assert.equal(config.sanctions_enabled, false);
  assert.equal(config.mode, "alert");
  assert.match(logs[0], /detection remains enabled/);
  assert.match(logs[0], /sanctions enforcement is disabled/);
});

test("recoverable safety and verified-user reads retry after transient Supabase errors", async () => {
  const transient = { data: null, count: null, error: { code: "ECONNRESET", message: "connection reset" } };
  const protectedDb = makeReadDb("security_protected_users", [
    transient,
    { data: { user_id: 123 }, error: null },
  ]);
  assert.equal(await isProtectedUser(protectedDb, -100, 123), true);
  assert.equal(protectedDb.calls, 2);

  const warningDb = makeReadDb("security_events", [
    transient,
    { count: 4, error: null },
  ]);
  assert.equal(await getWarningCount(warningDb, -100, 123), 4);
  assert.equal(warningDb.calls, 2);

  const verifiedDb = makeReadDb("verified_users", [
    transient,
    {
      data: {
        id: "verification-1",
        group_id: -100,
        user_id: 123,
        verified: true,
        revoked_at: null,
        permissions: { can_post: false },
      },
      error: null,
    },
  ]);
  const permissions = await getVerifiedUserPermissions(verifiedDb, -100, 123);
  assert.equal(verifiedDb.calls, 2);
  assert.equal(permissions.can_post, false);
  assert.equal(permissions.bypass_antispam, false);
});

test("logging failure does not replace the fail-closed configuration fallback", async () => {
  const db = makeConfigDb([
    { data: null, error: { code: "ECONNRESET", message: "connection reset" } },
  ]);
  const config = await getSecurityConfigResilient(db, -100, () => {
    throw new Error("logger failed");
  });

  assert.equal(db.calls, 3);
  assert.equal(config.safe_mode, true);
  assert.equal(config.sanctions_enabled, false);
});

test("critical violations remain detected but are not sanctioned with unsafe fallback config", async () => {
  const unavailableDb = makeConfigDb([
    { data: null, error: { code: "ECONNRESET", message: "connection reset" } },
  ]);
  const config = await getSecurityConfigResilient(unavailableDb, -100, () => {});
  const insertedEvents = [];
  const eventDb = {
    from(table) {
      assert.equal(table, "security_events");
      return {
        async insert(event) {
          insertedEvents.push(event);
          return { error: null };
        },
      };
    },
  };
  let telegramActions = 0;
  const ctx = {
    chat: { id: -100, type: "supergroup", title: "test" },
    from: { id: 123, is_bot: false, username: "user" },
    message: { message_id: 456, text: "Vendo CP de menores" },
    api: {
      getChatMember: async () => {
        telegramActions += 1;
        return { status: "administrator", can_delete_messages: true, can_restrict_members: true };
      },
      deleteMessage: async () => {
        telegramActions += 1;
      },
      banChatMember: async () => {
        telegramActions += 1;
      },
    },
    me: { id: 999 },
  };
  const verifiedPermissions = {
    can_post: true,
    can_send_media: true,
    can_send_links: true,
    bypass_antispam: false,
    bypass_promotion_filter: false,
    bypass_illegal_filter: false,
    bypass_automatic_deletion: false,
  };

  await detectSpam(ctx, eventDb, config, verifiedPermissions);

  assert.equal(telegramActions, 0);
  assert.equal(insertedEvents.length, 1);
  assert.equal(insertedEvents[0].event_type, "security_violation");
  assert.equal(insertedEvents[0].details.actionPerformed, "detected");
  assert.equal(insertedEvents[0].details.actionError, "SANCTIONS_DISABLED_BY_CONFIG");
});
