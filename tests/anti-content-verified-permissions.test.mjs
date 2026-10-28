import assert from "node:assert/strict";
import test from "node:test";
import { processMedia } from "../dist/anti-content/detector.js";

function createRow(overrides = {}) {
  return {
    id: "verified-1",
    group_id: -100123,
    user_id: 42,
    username: "sample",
    display_name: "Sample",
    verified: true,
    permissions: {
      can_post: true,
      can_send_media: true,
      can_send_links: true,
      bypass_antispam: true,
      bypass_promotion_filter: true,
      bypass_illegal_filter: true,
      bypass_automatic_deletion: true,
    },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    created_by: 1,
    revoked_at: null,
    valid_until: null,
    ...overrides,
  };
}

function createDatabase({ verifiedRow, verifiedError = null }) {
  const inserts = [];
  const tableState = {
    security_events: { selectResult: { count: 0, error: null } },
  };
  const builderFor = (table) => {
    const builder = {
      select() {
        return builder;
      },
      insert(row) {
        inserts.push([table, row]);
        return Promise.resolve({ error: null });
      },
      eq() {
        return builder;
      },
      is() {
        return builder;
      },
      gt() {
        return builder;
      },
      maybeSingle() {
        if (table === "verified_users") {
          return Promise.resolve(
            verifiedError
              ? { data: null, error: verifiedError }
              : { data: verifiedRow ?? null, error: null },
          );
        }
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        const state = tableState[table] ?? { selectResult: { count: 0, error: null } };
        return Promise.resolve(state.selectResult).then(resolve, reject);
      },
    };
    return builder;
  };
  return { from: (table) => builderFor(table), inserts };
}

function createConfig() {
  return {
    group_id: -100123,
    enabled: true,
    safe_mode: false,
    sanctions_enabled: true,
    mode: "automatic",
    anti_spam: true,
    anti_flood: true,
    anti_links: true,
    anti_content: true,
    media_protection: true,
    prohibited_words: [],
    allowed_link_domains: [],
    warning_two_action: "warn",
    warning_three_action: "mute",
    warning_four_action: "ban",
    reincidence_enabled: false,
    rules: { nsfw: { enabled: true, severity: "high", action: "delete" } },
    sticker_limit: 5,
    media_limit: 8,
  };
}

function createCtx(calls) {
  return {
    chat: { id: -100123, type: "supergroup", title: "Grupo" },
    from: { id: 42, is_bot: false, username: "sample" },
    me: { id: 999 },
    message: { message_id: 7 },
    api: {
      async getChatMember(_chatId, userId) {
        if (userId === 999) {
          return { status: "administrator", can_delete_messages: true };
        }
        return { status: "member", user: { id: userId } };
      },
      async deleteMessage() {
        calls.deleteMessage += 1;
      },
    },
  };
}

const provider = {
  async detect() {
    return { detected: true, category: "nsfw", reason: "contenido prohibido", critical: false };
  },
};

const criticalProvider = {
  async detect() {
    return { detected: true, category: "nsfw", reason: "contenido critico", critical: true };
  },
};

async function runProcessMedia({ verifiedRow, verifiedError = null, useCriticalProvider = false }) {
  const calls = { deleteMessage: 0 };
  const db = createDatabase({ verifiedRow, verifiedError });
  const ctx = createCtx(calls);
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => {
    logged.push(args.map((value) => String(value)).join(" "));
  };
  try {
    await processMedia(ctx, db, createConfig(), useCriticalProvider ? criticalProvider : provider);
  } finally {
    console.error = originalConsoleError;
  }
  return { calls, db, logged };
}

test("a Supabase failure while reading permissions grants no exemptions and keeps moderation active", async () => {
  const { calls, logged } = await runProcessMedia({
    verifiedError: { code: "PGRST116", message: "permission denied for table verified_users" },
  });
  assert.equal(calls.deleteMessage, 1, "la moderación debe continuar sin excepciones");
  assert.ok(
    logged.some((line) => line.includes("verified permission read failed")),
    "el fallo debe registrarse",
  );
});

test("an active verified user with illegal-filter bypass is exempt for non-critical detections", async () => {
  const { calls } = await runProcessMedia({
    verifiedRow: createRow({ valid_until: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
  });
  assert.equal(calls.deleteMessage, 0);
});

test("an expired verified record receives no exemption and is moderated", async () => {
  const { calls } = await runProcessMedia({
    verifiedRow: createRow({ valid_until: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
  });
  assert.equal(calls.deleteMessage, 1);
});

test("a legacy verified record without valid_until keeps its exemption", async () => {
  const { calls } = await runProcessMedia({ verifiedRow: createRow({ valid_until: null }) });
  assert.equal(calls.deleteMessage, 0);
});

test("critical detections are never exempt even for an active verified user", async () => {
  const { calls } = await runProcessMedia({
    verifiedRow: createRow({ valid_until: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
    useCriticalProvider: true,
  });
  assert.equal(calls.deleteMessage, 1);
});
