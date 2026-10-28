import assert from "node:assert/strict";
import test from "node:test";
import { createIdempotentShutdown } from "../dist/services/shutdown.js";

test("repeated shutdown signals stop the poller once and do not leave it active", async () => {
  let activePollers = 1;
  let stopCalls = 0;
  const shutdown = createIdempotentShutdown([
    () => {
      stopCalls += 1;
      activePollers -= 1;
    },
    async () => {},
  ]);

  await Promise.all([shutdown(), shutdown()]);

  assert.equal(stopCalls, 1);
  assert.equal(activePollers, 0);
});

test("shutdown still stops later services when an earlier cleanup step fails", async () => {
  let botStopped = false;
  const shutdown = createIdempotentShutdown([
    async () => {
      throw new Error("database offline");
    },
    () => {
      botStopped = true;
    },
  ]);

  await assert.rejects(shutdown(), /database offline/);
  assert.equal(botStopped, true);
  await assert.rejects(shutdown(), /database offline/);
});
