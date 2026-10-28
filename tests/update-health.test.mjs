import assert from "node:assert/strict";
import test from "node:test";
import { Bot } from "grammy";
import { getServiceHealth } from "../dist/services/resilience.js";
import { installUpdateHealthHandling } from "../dist/services/update-health.js";

test("grammY catches a failed update and restores update health after a later success", async () => {
  const bot = new Bot("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    },
  });
  const logged = [];
  let updates = 0;
  installUpdateHealthHandling(bot, (message) => logged.push(message));
  bot.use(async (_ctx, next) => {
    updates += 1;
    if (updates === 1) throw new Error("isolated middleware failure");
    await next();
  });

  await bot.handleUpdates([{ update_id: 1 }]);
  const degraded = getServiceHealth("updates");
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.consecutiveFailures, 1);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /update handler failed; health=degraded/);
  assert.match(logged[0], /isolated middleware failure/);

  await bot.handleUpdates([{ update_id: 2 }]);
  assert.equal(updates, 2);
  assert.equal(getServiceHealth("updates").status, "healthy");
  assert.equal(getServiceHealth("updates").consecutiveFailures, 0);
  assert.equal(logged.length, 1);
});

test("a failed update logger cannot reject grammY's error handler or block the next update", async () => {
  const bot = new Bot("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi", {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: "Test",
      username: "test_bot",
    },
  });
  const fallbackLogs = [];
  const originalConsoleError = console.error;
  let updates = 0;
  console.error = (...args) => fallbackLogs.push(args.join(" "));
  try {
    installUpdateHealthHandling(bot, () => {
      throw new Error("logger secret=must-not-be-logged");
    });
    bot.use(async (_ctx, next) => {
      updates += 1;
      if (updates === 1) throw new Error("isolated update failure");
      await next();
    });

    await bot.handleUpdates([{ update_id: 10 }]);
    await bot.handleUpdates([{ update_id: 11 }]);

    assert.equal(updates, 2);
    assert.equal(fallbackLogs.length, 1);
    assert.match(fallbackLogs[0], /update handler failed/);
    assert.match(fallbackLogs[0], /isolated update failure/);
    assert.doesNotMatch(fallbackLogs[0], /must-not-be-logged/);
  } finally {
    console.error = originalConsoleError;
  }
});
