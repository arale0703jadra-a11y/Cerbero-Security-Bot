import assert from "node:assert/strict";
import test from "node:test";
import {
  detectSpam,
  hasDisallowedLink,
} from "../dist/anti-spam/detector.js";

function createConfig(overrides = {}) {
  return {
    group_id: -1001,
    enabled: true,
    safe_mode: false,
    sanctions_enabled: true,
    mode: "alert",
    anti_spam: false,
    anti_flood: false,
    anti_links: true,
    anti_content: true,
    media_protection: false,
    prohibited_words: [],
    allowed_link_domains: ["good.example"],
    warning_two_action: "mute",
    warning_three_action: "kick",
    warning_four_action: "ban",
    reincidence_enabled: false,
    rules: {},
    sticker_limit: 5,
    media_limit: 8,
    ...overrides,
  };
}

function createDatabase() {
  const events = [];
  const builder = {
    select() {
      return builder;
    },
    eq() {
      return builder;
    },
    insert(event) {
      events.push(event);
      return Promise.resolve({ error: null });
    },
    then(resolve, reject) {
      return Promise.resolve({ count: 0, error: null }).then(resolve, reject);
    },
  };
  return { db: { from: () => builder }, events };
}

function createContext(text) {
  const actions = [];
  const ctx = {
    chat: { id: -1001, type: "supergroup", title: "Test" },
    from: { id: 42, is_bot: false },
    message: { message_id: 7, text },
    me: { id: 900 },
    api: {
      getChatMember: async () => {
        actions.push("getChatMember");
        return { status: "administrator", can_restrict_members: true };
      },
      deleteMessage: async () => actions.push("deleteMessage"),
      banChatMember: async () => actions.push("banChatMember"),
    },
  };
  return { ctx, actions };
}

const noVerifiedExemptions = {
  can_post: true,
  can_send_media: true,
  can_send_links: true,
  bypass_antispam: false,
  bypass_promotion_filter: false,
  bypass_illegal_filter: false,
  bypass_automatic_deletion: false,
};

test("allowed domains match exact hosts and their subdomains", () => {
  assert.equal(
    hasDisallowedLink("https://good.example/path", ["good.example"]),
    false,
  );
  assert.equal(
    hasDisallowedLink("https://shop.good.example/path", ["good.example"]),
    false,
  );
});

test("an allowed domain in a URL path or query does not allow an untrusted host", () => {
  assert.equal(
    hasDisallowedLink(
      "https://evil.example/?next=good.example",
      ["good.example"],
    ),
    true,
  );
  assert.equal(
    hasDisallowedLink(
      "https://good.example.evil.example/path",
      ["good.example"],
    ),
    true,
  );
});

test("short links, www links and punctuation are parsed by hostname", () => {
  assert.equal(hasDisallowedLink("www.good.example.", ["good.example"]), false);
  assert.equal(hasDisallowedLink("t.me/channel", ["good.example"]), true);
});

test("links are disallowed when the configured allowlist is empty", () => {
  assert.equal(hasDisallowedLink("https://good.example", []), true);
  assert.equal(hasDisallowedLink("mensaje sin enlace", []), false);
});

test("the anti-link detector allows allowlisted hosts and reports untrusted hosts", async () => {
  for (const [text, expectedViolations] of [
    ["Consulta https://shop.good.example/info", 0],
    ["Consulta https://evil.example/?next=good.example", 1],
  ]) {
    const { db, events } = createDatabase();
    const { ctx } = createContext(text);
    await detectSpam(ctx, db, createConfig(), noVerifiedExemptions);
    assert.equal(
      events.filter((event) => event.event_type === "security_violation").length,
      expectedViolations,
      text,
    );
  }
});

test("informational human-rights video messages do not trigger critical enforcement", async () => {
  const { db, events } = createDatabase();
  const { ctx, actions } = createContext(
    "Este video analiza la violación de derechos humanos en la guerra",
  );
  await detectSpam(
    ctx,
    db,
    createConfig({ anti_links: false }),
    noVerifiedExemptions,
  );

  assert.deepEqual(actions, []);
  assert.equal(events.length, 0);
});
