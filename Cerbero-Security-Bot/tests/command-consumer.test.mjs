import assert from "node:assert/strict";
import test from "node:test";
import {
  CommandConsumer,
  CommandLeaseMonitor,
} from "../dist/security/command-consumer.js";

function createMonitorHarness(renewLease, reportLeaseLoss = () => {}) {
  let scheduledCallback;
  let cancelled = false;
  let scheduleCount = 0;
  const monitor = new CommandLeaseMonitor(
    "command-1",
    renewLease,
    (callback) => {
      scheduleCount += 1;
      scheduledCallback = callback;
      return () => {
        cancelled = true;
      };
    },
    reportLeaseLoss,
  );
  return {
    monitor,
    trigger: () => scheduledCallback?.(),
    get cancelled() {
      return cancelled;
    },
    get scheduleCount() {
      return scheduleCount;
    },
  };
}

async function flushRenewal() {
  await new Promise((resolve) => setImmediate(resolve));
}

function command(overrides = {}) {
  return {
    id: "command-1",
    group_id: -100123,
    action: "BAN_USER",
    target_user_id: 456,
    target_message_id: null,
    payload: {},
    status: "processing",
    result_state: "processing",
    processing_instance_id: "instance-1",
    processing_token: "fence-1",
    created_at: new Date().toISOString(),
    executed_at: null,
    ...overrides,
  };
}

function createConsumerHarness(overrides = {}) {
  const logs = [];
  const completions = [];
  const unknownWrites = [];
  const events = [];
  const audits = [];
  const schedules = [];
  const dependencies = {
    isSupportedAction: () => true,
    isProtectedUser: async () => false,
    executeCommand: async () => ({}),
    completeCommand: async (...args) => {
      completions.push(args);
      return true;
    },
    markCommandUnknown: async (...args) => {
      unknownWrites.push(args);
      return true;
    },
    renewCommandLease: async () => true,
    publishEvent: async (...args) => events.push(args),
    publishAudit: async (...args) => audits.push(args),
    scheduleLeaseRenewal: (callback) => {
      const schedule = { callback, cancelled: false };
      schedules.push(schedule);
      return () => {
        schedule.cancelled = true;
      };
    },
    logError: (message, error) => logs.push({ message, error }),
    ...overrides,
  };
  const consumer = new CommandConsumer({}, {}, "instance-1", 2_000, dependencies);
  return {
    consumer,
    logs,
    completions,
    unknownWrites,
    events,
    audits,
    schedules,
  };
}

test("a successful lease renewal leaves legitimate command work enabled", async () => {
  let renewals = 0;
  const harness = createMonitorHarness(async () => {
    renewals += 1;
    return true;
  });
  harness.monitor.start();
  harness.trigger();
  await flushRenewal();

  let actionsStarted = 0;
  const result = await harness.monitor.runIfHeld(async () => {
    actionsStarted += 1;
    return "executed";
  });

  assert.equal(renewals, 1);
  assert.equal(result.started, true);
  assert.equal(result.value, "executed");
  assert.equal(result.leaseHeld, true);
  assert.equal(actionsStarted, 1);
  assert.equal(harness.cancelled, false);
  harness.monitor.stop();
});

test("a false renewal is logged, stops the timer, and prevents later work", async () => {
  let renewals = 0;
  const logged = [];
  const harness = createMonitorHarness(
    async () => {
      renewals += 1;
      return false;
    },
    (message) => logged.push(message),
  );
  harness.monitor.start();
  harness.trigger();
  await flushRenewal();

  let actionsStarted = 0;
  const result = await harness.monitor.runIfHeld(async () => {
    actionsStarted += 1;
  });
  harness.trigger();
  await flushRenewal();

  assert.equal(result.started, false);
  assert.equal(actionsStarted, 0);
  assert.equal(renewals, 1);
  assert.equal(harness.cancelled, true);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Lease renewal matched no row.*commandId=command-1/);
});

test("a renewal error is logged and cannot create an unhandled rejection", async () => {
  const logged = [];
  const unhandledRejections = [];
  const onUnhandled = (reason) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const harness = createMonitorHarness(
    async () => {
      throw new Error("database unavailable");
    },
    (message) => logged.push(message),
  );
  try {
    harness.monitor.start();
    harness.trigger();
    await flushRenewal();

    let actionsStarted = 0;
    const result = await harness.monitor.runIfHeld(async () => {
      actionsStarted += 1;
    });
    await flushRenewal();
    await flushRenewal();
    assert.equal(result.started, false);
    assert.equal(actionsStarted, 0);
    assert.equal(harness.cancelled, true);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /Lease renewal failed.*database unavailable/);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    harness.monitor.stop();
    process.off("unhandledRejection", onUnhandled);
  }
});

test("losing the lease does not cancel an in-flight operation but blocks subsequent work", async () => {
  let resolveAction;
  let actionsStarted = 0;
  const actionInFlight = new Promise((resolve) => {
    resolveAction = resolve;
  });
  const harness = createMonitorHarness(async () => false);
  harness.monitor.start();
  const currentAction = harness.monitor.runIfHeld(async () => {
    actionsStarted += 1;
    return actionInFlight;
  });

  assert.equal(actionsStarted, 1);
  harness.trigger();
  await flushRenewal();
  assert.equal(harness.cancelled, true);
  assert.equal(harness.monitor.isLost, true);

  let subsequentActionsStarted = 0;
  const subsequent = await harness.monitor.runIfHeld(async () => {
    subsequentActionsStarted += 1;
  });
  assert.equal(subsequent.started, false);
  assert.equal(subsequentActionsStarted, 0);

  resolveAction("telegram-call-finished");
  const currentResult = await currentAction;
  assert.equal(currentResult.started, true);
  assert.equal(currentResult.value, "telegram-call-finished");
  assert.equal(currentResult.leaseHeld, false);
  assert.equal(harness.monitor.isLost, true);
  harness.monitor.stop();
});

test("a lost lease cannot start the command again or produce a completion value", async () => {
  const harness = createMonitorHarness(async () => false);
  harness.monitor.start();
  harness.trigger();
  await flushRenewal();

  let executions = 0;
  const firstAttempt = await harness.monitor.runIfHeld(async () => {
    executions += 1;
    return "completed";
  });
  const repeatedAttempt = await harness.monitor.runIfHeld(async () => {
    executions += 1;
    return "completed";
  });

  assert.equal(firstAttempt.started, false);
  assert.equal(repeatedAttempt.started, false);
  assert.equal(executions, 0);
  assert.equal(harness.monitor.isLost, true);
});

test("the real consumer completes a command after successful execution and stops renewal normally", async () => {
  const harness = createConsumerHarness();
  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions.length, 1);
  assert.equal(harness.completions[0][1], "command-1");
  assert.equal(harness.completions[0][2], "completed");
  assert.equal(harness.unknownWrites.length, 0);
  assert.equal(harness.events.length, 1);
  assert.equal(harness.events[0][2], "moderation_executed");
  assert.equal(harness.events[0][3].result, "completed");
  assert.equal(harness.schedules[0].cancelled, true);
  assert.equal(harness.logs.length, 0);
});

test("publication failures after confirmed completion are logged without making the command uncertain", async (t) => {
  for (const failurePoint of ["event", "audit"]) {
    await t.test(`${failurePoint} failure`, async () => {
      const secret = "token=privatePublisherCredential";
      const harness = createConsumerHarness({
        publishEvent: async () => {
          if (failurePoint === "event") throw new Error(`event unavailable ${secret}`);
        },
        publishAudit: async () => {
          if (failurePoint === "audit") throw new Error(`audit unavailable ${secret}`);
        },
      });

      await harness.consumer.processClaimedCommand(command());

      assert.equal(harness.completions.length, 1);
      assert.equal(harness.completions[0][2], "completed");
      assert.equal(harness.unknownWrites.length, 0);
      assert.equal(
        harness.logs.some((entry) => /command outcome uncertain/.test(entry.message)),
        false,
      );
      assert.match(
        harness.logs.map((entry) => entry.message).join("\n"),
        new RegExp(`post_completion_event_failed.*stage=${failurePoint}:moderation_executed`),
      );
      assert.doesNotMatch(
        harness.logs.map((entry) => entry.message).join("\n"),
        /privatePublisherCredential/,
      );
      assert.match(
        harness.logs.map((entry) => entry.message).join("\n"),
        /token=\[REDACTED\]/,
      );
    });
  }
});

test("event and audit publication failures after completion are both recorded independently", async () => {
  const harness = createConsumerHarness({
    publishEvent: async () => {
      throw new Error("event store unavailable");
    },
    publishAudit: async () => {
      throw new Error("audit store unavailable");
    },
  });

  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions.length, 1);
  assert.equal(harness.completions[0][2], "completed");
  assert.equal(harness.unknownWrites.length, 0);
  const publicationFailures = harness.logs
    .map((entry) => entry.message)
    .filter((message) => message.includes("post_completion_event_failed"));
  assert.equal(publicationFailures.length, 2);
  assert.match(publicationFailures[0], /stage=event:moderation_executed/);
  assert.match(publicationFailures[1], /stage=audit:moderation_executed/);
});

test("failure publishing an unknown result is logged after fenced persistence", async () => {
  const harness = createConsumerHarness({
    executeCommand: async () => {
      throw new Error("network timeout");
    },
    publishEvent: async () => {
      throw new Error("event store unavailable");
    },
  });

  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions.length, 0);
  assert.equal(harness.unknownWrites.length, 1);
  assert.equal(harness.unknownWrites[0][1], "command-1");
  assert.match(
    harness.logs.map((entry) => entry.message).join("\n"),
    /post_result_publication_failed.*persistedStatus=unknown stage=event:moderation_result/,
  );
  assert.doesNotMatch(
    harness.logs.map((entry) => entry.message).join("\n"),
    /command outcome uncertain/,
  );
});

test("returned execution errors are sanitized before persistence, event, and audit", async () => {
  const secret = "token=privateExecutionCredential";
  const harness = createConsumerHarness({
    executeCommand: async () => ({
      error: `CLEAN_MESSAGES_PARTIAL: ${secret}`,
      details: {
        attempted: 2,
        partialErrors: [`Telegram rejected ${secret}`],
      },
    }),
  });

  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions[0][3], "CLEAN_MESSAGES_PARTIAL: token=[REDACTED]");
  assert.equal(
    harness.events[0][3].partialErrors[0],
    "Telegram rejected token=[REDACTED]",
  );
  assert.equal(harness.audits[0][3].error, "CLEAN_MESSAGES_PARTIAL: token=[REDACTED]");
  assert.doesNotMatch(
    JSON.stringify([harness.completions, harness.events, harness.audits]),
    /privateExecutionCredential/,
  );
});

test("thrown execution reasons are sanitized before failed persistence and publication", async () => {
  const secret = "token=privateFailureCredential";
  const harness = createConsumerHarness({
    executeCommand: async () => {
      throw new Error(`INSUFFICIENT_PERMISSIONS: ${secret}`);
    },
  });

  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions[0][2], "failed");
  assert.equal(
    harness.completions[0][3],
    "INSUFFICIENT_PERMISSIONS: token=[REDACTED]",
  );
  assert.equal(harness.events[0][3].actionError, "INSUFFICIENT_PERMISSIONS: token=[REDACTED]");
  assert.equal(harness.audits[0][3].error, "INSUFFICIENT_PERMISSIONS: token=[REDACTED]");
  assert.doesNotMatch(
    JSON.stringify([harness.completions, harness.events, harness.audits]),
    /privateFailureCredential/,
  );
});

test("the real consumer does not start an external action when renewal loses the lease first", async () => {
  let externalActions = 0;
  const harness = createConsumerHarness({
    renewCommandLease: async () => false,
    isProtectedUser: async () => {
      harness.schedules[0].callback();
      await flushRenewal();
      return false;
    },
    executeCommand: async () => {
      externalActions += 1;
      return {};
    },
  });

  await harness.consumer.processClaimedCommand(command());

  assert.equal(externalActions, 0);
  assert.equal(harness.completions.length, 0);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.unknownWrites.length, 1);
  assert.match(
    harness.logs.map((entry) => entry.message).join("\n"),
    /lease_lost_before_external_action/,
  );
  assert.equal(harness.schedules[0].cancelled, true);
});

test("lease loss during an external action records uncertainty without cancellation or false completion", async () => {
  let resolveExecution;
  let externalActions = 0;
  const harness = createConsumerHarness({
    renewCommandLease: async () => false,
    executeCommand: async () => {
      externalActions += 1;
      return new Promise((resolve) => {
        resolveExecution = resolve;
      });
    },
  });
  const processing = harness.consumer.processClaimedCommand(command());
  while (!resolveExecution) await flushRenewal();

  harness.schedules[0].callback();
  await flushRenewal();
  assert.equal(harness.schedules[0].cancelled, true);

  resolveExecution({
    details: {
      attempted: 3,
      deleted: 3,
      failed: 0,
      alreadyApplied: 0,
      privateText: "must not be logged",
      credential: "privateCredentialValue",
    },
  });
  await processing;

  assert.equal(externalActions, 1);
  assert.equal(harness.completions.length, 0);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.unknownWrites.length, 1);
  const combinedLogs = harness.logs.map((entry) => entry.message).join("\n");
  const lastError = harness.unknownWrites[0][2];
  assert.match(combinedLogs, /externalOutcome=call_in_flight_or_returned/);
  assert.match(combinedLogs, /externalResponse=returned commandCompletion=unconfirmed/);
  assert.match(combinedLogs, /counts=\{"attempted":3,"deleted":3,"failed":0,"alreadyApplied":0\}/);
  assert.match(combinedLogs, /No automatic retry was started/);
  assert.match(lastError, /externalResponse=returned commandCompletion=unconfirmed/);
  assert.match(lastError, /counts=\{"attempted":3,"deleted":3,"failed":0,"alreadyApplied":0\}/);
  assert.doesNotMatch(combinedLogs + lastError, /must not be logged|privateCredentialValue/);
});

test("an external action that throws after lease loss remains an uncertain outcome", async () => {
  let rejectExecution;
  let externalActions = 0;
  const harness = createConsumerHarness({
    renewCommandLease: async () => false,
    executeCommand: async () => {
      externalActions += 1;
      return new Promise((_resolve, reject) => {
        rejectExecution = reject;
      });
    },
  });
  const processing = harness.consumer.processClaimedCommand(command());
  while (!rejectExecution) await flushRenewal();

  harness.schedules[0].callback();
  await flushRenewal();
  assert.equal(harness.schedules[0].cancelled, true);

  rejectExecution(new Error("telegram request failed"));
  await processing;

  assert.equal(externalActions, 1);
  assert.equal(harness.completions.length, 0);
  assert.equal(harness.events.length, 0);
  assert.equal(harness.unknownWrites.length, 1);
  assert.match(
    harness.logs.map((entry) => entry.message).join("\n"),
    /stage=action_threw_after_lease_loss externalOutcome=call_threw/,
  );
  assert.match(harness.unknownWrites[0][2], /externalOutcome=call_threw/);
});

test("lease loss prevents the real consumer from completing the order successfully", async () => {
  let resolveExecution;
  const harness = createConsumerHarness({
    renewCommandLease: async () => false,
    executeCommand: async () =>
      new Promise((resolve) => {
        resolveExecution = resolve;
      }),
  });
  const processing = harness.consumer.processClaimedCommand(command());
  while (!resolveExecution) await flushRenewal();
  harness.schedules[0].callback();
  await flushRenewal();
  resolveExecution({});
  await processing;

  assert.equal(harness.completions.length, 0);
  assert.equal(harness.events.some((event) => event[3]?.result === "completed"), false);
  assert.equal(harness.unknownWrites.length, 1);
});

test("a database error during consumer finalization is logged and is not reported as success", async () => {
  const harness = createConsumerHarness({
    completeCommand: async () => {
      throw new Error("completion database unavailable");
    },
    markCommandUnknown: async () => false,
  });
  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions.length, 0);
  assert.equal(harness.events.length, 0);
  assert.match(
    harness.logs.map((entry) => entry.message).join("\n"),
    /finalization_write_failed.*completion database unavailable/,
  );
  assert.match(
    harness.logs.map((entry) => entry.message).join("\n"),
    /fenced unknown-state update did not match/,
  );
});

test("a claimed command without a valid fencing identity starts no external action", async () => {
  let externalActions = 0;
  const harness = createConsumerHarness({
    executeCommand: async () => {
      externalActions += 1;
      return {};
    },
  });
  await harness.consumer.processClaimedCommand(
    command({ processing_token: null }),
  );

  assert.equal(externalActions, 0);
  assert.equal(harness.completions.length, 0);
  assert.equal(harness.unknownWrites.length, 0);
  assert.equal(harness.schedules.length, 0);
  assert.match(harness.logs[0].message, /Refusing command without valid fenced execution identity/);
});

test("a renewal error in the real consumer is logged without an unhandled rejection", async () => {
  let resolveExecution;
  const unhandledRejections = [];
  const onUnhandled = (reason) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const harness = createConsumerHarness({
    renewCommandLease: async () => {
      throw new Error("renew database unavailable");
    },
    executeCommand: async () =>
      new Promise((resolve) => {
        resolveExecution = resolve;
      }),
  });
  try {
    const processing = harness.consumer.processClaimedCommand(command());
    while (!resolveExecution) await flushRenewal();
    harness.schedules[0].callback();
    await flushRenewal();
    resolveExecution({});
    await processing;

    assert.equal(harness.completions.length, 0);
    assert.equal(harness.unknownWrites.length, 1);
    assert.match(
      harness.logs.map((entry) => entry.message).join("\n"),
      /Lease renewal failed.*renew database unavailable/,
    );
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("normal monitor stop is not treated as lease loss by the real consumer", async () => {
  const harness = createConsumerHarness();
  await harness.consumer.processClaimedCommand(command());

  assert.equal(harness.completions.length, 1);
  assert.equal(harness.unknownWrites.length, 0);
  assert.equal(harness.logs.length, 0);
  assert.equal(harness.schedules[0].cancelled, true);
});

test("two real consumer monitors remain independent and each cleans up its timer", async () => {
  let resolveFirst;
  let resolveSecond;
  const harness = createConsumerHarness({
    renewCommandLease: async (_db, id) => id !== "command-1",
    executeCommand: async (_db, _ctx, current) =>
      new Promise((resolve) => {
        if (current.id === "command-1") resolveFirst = resolve;
        else resolveSecond = resolve;
      }),
  });
  const first = harness.consumer.processClaimedCommand(command());
  const second = harness.consumer.processClaimedCommand(
    command({ id: "command-2", processing_token: "fence-2" }),
  );
  while (!resolveFirst || !resolveSecond) await flushRenewal();

  assert.equal(harness.schedules.length, 2);
  harness.schedules[0].callback();
  harness.schedules[1].callback();
  await flushRenewal();
  assert.equal(harness.schedules[0].cancelled, true);
  assert.equal(harness.schedules[1].cancelled, false);

  resolveFirst({});
  resolveSecond({});
  await Promise.all([first, second]);

  assert.equal(harness.completions.length, 1);
  assert.equal(harness.completions[0][1], "command-2");
  assert.equal(harness.unknownWrites.length, 1);
  assert.equal(harness.schedules[0].cancelled, true);
  assert.equal(harness.schedules[1].cancelled, true);
});
