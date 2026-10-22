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
