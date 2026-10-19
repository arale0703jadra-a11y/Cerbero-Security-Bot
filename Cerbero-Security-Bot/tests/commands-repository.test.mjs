import assert from "node:assert/strict";
import test from "node:test";
import {
  completeCommand,
  getCommandResultState,
  markCommandUnknown,
  renewCommandLease,
} from "../dist/database/repositories/commands-repository.js";

function createDatabase(updateResult) {
  const filters = [];
  const updates = [];
  const query = {
    update(values) {
      updates.push(values);
      return query;
    },
    eq(column, value) {
      filters.push([column, value]);
      return query;
    },
    select() {
      return Promise.resolve(updateResult);
    },
  };
  return {
    filters,
    updates,
    db: {
      from(table) {
        assert.equal(table, "security_commands");
        return query;
      },
    },
  };
}

function createStatefulDatabase(initialRow) {
  const row = { ...initialRow };
  const operations = [];
  const db = {
    from(table) {
      assert.equal(table, "security_commands");
      let filters = [];
      let values;
      const query = {
        update(nextValues) {
          values = nextValues;
          filters = [];
          return query;
        },
        eq(column, value) {
          filters.push(["eq", column, value]);
          return query;
        },
        gt(column, value) {
          filters.push(["gt", column, value]);
          return query;
        },
        async select() {
          operations.push({ values: { ...values }, filters: [...filters] });
          const matches = filters.every(([operator, column, value]) => {
            if (operator === "eq") return row[column] === value;
            if (operator === "gt") {
              return new Date(row[column]).getTime() > new Date(value).getTime();
            }
            return false;
          });
          if (!matches) return { data: [], error: null };
          Object.assign(row, values);
          return { data: [{ id: row.id }], error: null };
        },
      };
      return query;
    },
  };
  return { db, row, operations };
}

function processingRow(overrides = {}) {
  return {
    id: "command-1",
    status: "processing",
    processing_instance_id: "instance-1",
    processing_token: "token-1",
    result_state: "processing",
    lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    last_error: null,
    ...overrides,
  };
}

test("command result state preserves queued and reports expired leases as unknown", () => {
  assert.equal(getCommandResultState({ status: "pending" }), "queued");
  assert.equal(getCommandResultState({ result_state: "queued" }), "queued");
  assert.equal(
    getCommandResultState({
      status: "processing",
      lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    }),
    "unknown",
  );
  assert.equal(
    getCommandResultState({
      status: "processing",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    }),
    "processing",
  );
  assert.equal(getCommandResultState({ status: "completed" }), "completed");
  assert.equal(getCommandResultState({ result_state: "unknown" }), "unknown");
});

test("completion is not reported when the processing owner no longer matches", async () => {
  const fake = createDatabase({ data: [], error: null });
  const completed = await completeCommand(
    fake.db,
    "command-1",
    "completed",
    undefined,
    "instance-1",
    "token-1",
  );

  assert.equal(completed, false);
  assert.deepEqual(fake.filters, [
    ["id", "command-1"],
    ["status", "processing"],
    ["processing_instance_id", "instance-1"],
    ["processing_token", "token-1"],
  ]);
});

test("completion reports true only when the owner-fenced update matched a row", async () => {
  const fake = createDatabase({ data: [{ id: "command-1" }], error: null });
  const completed = await completeCommand(
    fake.db,
    "command-1",
    "completed",
    undefined,
    "instance-1",
    "token-1",
  );

  assert.equal(completed, true);
  assert.equal(fake.updates[0].result_state, "completed");
});

test("uncertain outcomes retain processing ownership and are marked unknown", async () => {
  const fake = createDatabase({ data: [{ id: "command-1" }], error: null });
  const marked = await markCommandUnknown(
    fake.db,
    "command-1",
    "Telegram response timed out",
    "instance-1",
    "token-1",
  );

  assert.equal(marked, true);
  assert.deepEqual(fake.updates[0], {
    result_state: "unknown",
    last_error: "Telegram response timed out",
  });
  assert.deepEqual(fake.filters, [
    ["id", "command-1"],
    ["status", "processing"],
    ["processing_instance_id", "instance-1"],
    ["processing_token", "token-1"],
  ]);
});

test("a normal lease renewal updates a currently processing, unexpired owned command", async () => {
  const startedAt = Date.now();
  const fake = createStatefulDatabase(processingRow());
  const renewed = await renewCommandLease(
    fake.db,
    "command-1",
    "instance-1",
    "token-1",
  );

  assert.equal(renewed, true);
  assert.equal(fake.row.result_state, "processing");
  assert.ok(new Date(fake.row.lease_expires_at).getTime() > Date.now());
  assert.deepEqual(fake.operations[0].filters.slice(0, 5), [
    ["eq", "id", "command-1"],
    ["eq", "status", "processing"],
    ["eq", "processing_instance_id", "instance-1"],
    ["eq", "processing_token", "token-1"],
    ["eq", "result_state", "processing"],
  ]);
  const expiryFilter = fake.operations[0].filters[5];
  assert.equal(expiryFilter[0], "gt");
  assert.equal(expiryFilter[1], "lease_expires_at");
  assert.ok(new Date(expiryFilter[2]).getTime() >= startedAt);
  assert.ok(new Date(expiryFilter[2]).getTime() <= Date.now());
});

test("a late renewal cannot change an order marked unknown back to processing", async () => {
  const fake = createStatefulDatabase(processingRow());
  const markedUnknown = await markCommandUnknown(
    fake.db,
    "command-1",
    "Telegram response timed out",
    "instance-1",
    "token-1",
  );
  const leaseBeforeRenewal = fake.row.lease_expires_at;
  const renewed = await renewCommandLease(
    fake.db,
    "command-1",
    "instance-1",
    "token-1",
  );

  assert.equal(markedUnknown, true);
  assert.equal(renewed, false);
  assert.equal(fake.row.result_state, "unknown");
  assert.equal(fake.row.last_error, "Telegram response timed out");
  assert.equal(fake.row.lease_expires_at, leaseBeforeRenewal);
  assert.deepEqual(fake.operations[1].filters.slice(0, 5), [
    ["eq", "id", "command-1"],
    ["eq", "status", "processing"],
    ["eq", "processing_instance_id", "instance-1"],
    ["eq", "processing_token", "token-1"],
    ["eq", "result_state", "processing"],
  ]);
});

test("a lease renewal does not update a command owned by another instance or fencing token", async () => {
  for (const ownership of [
    { processing_instance_id: "instance-2", processing_token: "token-1" },
    { processing_instance_id: "instance-1", processing_token: "token-2" },
  ]) {
    const fake = createStatefulDatabase(processingRow(ownership));
    const leaseBeforeRenewal = fake.row.lease_expires_at;
    const renewed = await renewCommandLease(
      fake.db,
      "command-1",
      "instance-1",
      "token-1",
    );

    assert.equal(renewed, false);
    assert.equal(fake.row.result_state, "processing");
    assert.equal(fake.row.lease_expires_at, leaseBeforeRenewal);
    assert.deepEqual(fake.operations[0].filters.slice(0, 4), [
      ["eq", "id", "command-1"],
      ["eq", "status", "processing"],
      ["eq", "processing_instance_id", "instance-1"],
      ["eq", "processing_token", "token-1"],
    ]);
  }
});

test("a late renewal cannot recover an already expired lease", async () => {
  const expiredAt = new Date(Date.now() - 1_000).toISOString();
  const fake = createStatefulDatabase(
    processingRow({ lease_expires_at: expiredAt }),
  );
  const renewed = await renewCommandLease(
    fake.db,
    "command-1",
    "instance-1",
    "token-1",
  );

  assert.equal(renewed, false);
  assert.equal(fake.row.lease_expires_at, expiredAt);
  assert.equal(fake.row.result_state, "processing");
  assert.ok(
    fake.operations[0].filters.some(
      ([operator, column]) => operator === "gt" && column === "lease_expires_at",
    ),
  );
});

test("database errors during completion are surfaced", async () => {
  const fake = createDatabase({ data: null, error: new Error("database unavailable") });

  await assert.rejects(
    completeCommand(fake.db, "command-1", "completed", undefined, "instance-1", "token-1"),
    /database unavailable/,
  );
});
