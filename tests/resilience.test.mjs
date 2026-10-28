import assert from "node:assert/strict";
import test from "node:test";
import { getSecurityConfigResilient } from "../dist/database/repositories/security-config-repository.js";
import {
  classifyError,
  getServiceHealth,
  recordServiceHealth,
  safeErrorMessage,
  withControlledRetries,
} from "../dist/services/resilience.js";

test("transient failures retry with bounded exponential delays and recover", async () => {
  const delays = [];
  let attempts = 0;
  const result = await withControlledRetries(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error("upstream unavailable"), { status: 503 });
    return "ok";
  }, {
    maxAttempts: 3,
    baseDelayMs: 10,
    maxDelayMs: 20,
    delay: async (milliseconds) => delays.push(milliseconds),
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal(classifyError(Object.assign(new Error("busy"), { status: 429 })), "transient");
});

test("permanent errors do not retry and transient exhaustion is bounded", async () => {
  let attempts = 0;
  await assert.rejects(
    withControlledRetries(async () => {
      attempts += 1;
      throw Object.assign(new Error("permission denied"), { status: 403 });
    }, { maxAttempts: 4, delay: async () => {} }),
    /permission denied/,
  );
  assert.equal(attempts, 1);
  assert.equal(classifyError(Object.assign(new Error("invalid request"), { status: 400 })), "permanent");

  attempts = 0;
  await assert.rejects(
    withControlledRetries(async () => {
      attempts += 1;
      throw Object.assign(new Error("gateway timeout"), { status: 504 });
    }, { maxAttempts: 2, delay: async () => {} }),
    /gateway timeout/,
  );
  assert.equal(attempts, 2);
});

test("health state records degradation and clears after recovery", () => {
  recordServiceHealth("test-resilience", Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
  const degraded = getServiceHealth("test-resilience");
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.consecutiveFailures, 1);
  assert.equal(degraded.lastErrorClass, "transient");

  recordServiceHealth("test-resilience");
  const healthy = getServiceHealth("test-resilience");
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.consecutiveFailures, 0);
});

test("safe error summaries redact secrets inside aggregate shutdown errors", () => {
  const error = new AggregateError([
    new Error("database failed token=private-token"),
    new Error("bot stop failed"),
  ], "multiple shutdown steps failed");
  const summary = safeErrorMessage(error);

  assert.match(summary, /token=\[REDACTED\]/);
  assert.match(summary, /bot stop failed/);
  assert.doesNotMatch(summary, /private-token/);
});

test("a permanent config-read failure keeps detection active and disables per-rule actions", async () => {
  let reads = 0;
  const db = {
    from(table) {
      assert.equal(table, "security_group_configs");
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() {
          reads += 1;
          return {
            data: null,
            error: Object.assign(new Error("permission denied"), { status: 403 }),
          };
        },
      };
      return query;
    },
  };
  const originalError = console.error;
  const diagnostics = [];
  console.error = (message) => diagnostics.push(message);
  try {
    const fallback = await getSecurityConfigResilient(db, -100123);
    assert.equal(reads, 1);
    assert.equal(fallback.enabled, true);
    assert.equal(fallback.safe_mode, true);
    assert.equal(fallback.sanctions_enabled, false);
    assert.equal(fallback.mode, "alert");
    assert.ok(fallback.anti_spam && fallback.anti_flood && fallback.anti_links && fallback.anti_content);
    for (const rule of Object.values(fallback.rules)) {
      assert.equal(rule.enabled, false);
      assert.equal(rule.action, "detect");
    }
    assert.equal(getServiceHealth("security-config").status, "degraded");
    assert.match(diagnostics[0], /detection remains enabled/);
    assert.match(diagnostics[0], /sanctions enforcement is disabled/);
  } finally {
    console.error = originalError;
  }
});
