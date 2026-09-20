import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openDatabase } from "./db/client.js";
import {
  OperationOutcomeUnknownError,
  OperationReceiptManager,
} from "./operation-receipts.js";

const op = (suffix: string) => `op-test-${suffix}`;

test("replays a completed operation without executing twice", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  const input = {
    workspaceId: "ws_1",
    operationId: op("completed"),
    tool: "write",
    request: { path: "a.txt", content: "hello" },
    execute: async () => ++executions,
  };
  assert.deepEqual(await manager.run(input), { value: 1, replayed: false });
  assert.deepEqual(await manager.run(input), { value: 1, replayed: true });
  assert.equal(executions, 1);
});

test("joins an in-flight duplicate", async () => {
  const manager = new OperationReceiptManager();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let executions = 0;
  const input = {
    workspaceId: "ws_1",
    operationId: op("inflight"),
    tool: "bash",
    request: { command: "slow" },
    execute: async () => { executions++; await gate; return 42; },
  };
  const first = manager.run(input);
  const second = manager.run(input);
  await Promise.resolve();
  assert.equal(executions, 1);
  release();
  assert.deepEqual(await first, { value: 42, replayed: false });
  assert.deepEqual(await second, { value: 42, replayed: true });
});

test("replays the same failure without repeating its side effect", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  const input = {
    workspaceId: "ws_1",
    operationId: op("failure"),
    tool: "bash",
    request: { command: "danger" },
    execute: async () => { executions++; throw new Error("failed after side effect"); },
  };
  await assert.rejects(manager.run(input), /failed after side effect/);
  await assert.rejects(manager.run(input), /failed after side effect/);
  assert.equal(executions, 1);
});

test("rejects reusing an operation id for a changed request", async () => {
  const manager = new OperationReceiptManager();
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("conflict"),
    tool: "write",
    request: { content: "one" },
    execute: async () => "ok",
  });
  await assert.rejects(manager.run({
    workspaceId: "ws_1",
    operationId: op("conflict"),
    tool: "write",
    request: { content: "two" },
    execute: async () => "wrong",
  }), /different request/);
});

test("canonicalizes object key order", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("canonical"),
    tool: "edit",
    request: { a: 1, nested: { x: true, y: "z" } },
    execute: async () => ++executions,
  });
  const replay = await manager.run({
    workspaceId: "ws_1",
    operationId: op("canonical"),
    tool: "edit",
    request: { nested: { y: "z", x: true }, a: 1 },
    execute: async () => ++executions,
  });
  assert.equal(replay.replayed, true);
  assert.equal(executions, 1);
});

test("compacts expired results to fail-closed tombstones", async () => {
  let now = 0;
  const manager = new OperationReceiptManager({ receiptTtlMs: 10, now: () => now });
  const first = {
    workspaceId: "ws_1",
    operationId: op("expired"),
    tool: "write",
    request: { content: "one" },
    execute: async () => "ok",
  };
  await manager.run(first);
  now = 11;

  // Trigger compaction with a different operation.
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("trigger"),
    tool: "write",
    request: { content: "two" },
    execute: async () => "ok",
  });

  await assert.rejects(manager.run(first), /stored result has expired/);
});

test("existing receipt remains replayable when tombstones are full", async () => {
  let now = 0;
  const manager = new OperationReceiptManager({
    receiptTtlMs: 10,
    maxReceipts: 3,
    maxTombstones: 1,
    now: () => now,
  });

  await manager.run({
    workspaceId: "ws_1",
    operationId: op("old-one"),
    tool: "write",
    request: { content: "one" },
    execute: async () => "one",
  });

  now = 11;
  // This compacts old-one into the only tombstone slot.
  await manager.run({
    workspaceId: "ws_1",
    operationId: op("trigger"),
    tool: "write",
    request: { content: "trigger" },
    execute: async () => "trigger",
  });

  const replayable = {
    workspaceId: "ws_1",
    operationId: op("replayable"),
    tool: "bash",
    request: { command: "echo safe" },
    execute: async () => "safe",
  };
  await manager.run(replayable);

  now = 22;
  // A brand-new operation is now blocked because compaction cannot create
  // another tombstone.
  await assert.rejects(manager.run({
    workspaceId: "ws_1",
    operationId: op("new-op"),
    tool: "write",
    request: { content: "new" },
    execute: async () => "new",
  }), /tombstone capacity reached/);

  // Retry safety must win over unrelated compaction pressure: the known
  // receipt is looked up first and replayed rather than executing twice.
  let duplicateExecutions = 0;
  const retry = await manager.run({
    ...replayable,
    execute: async () => { duplicateExecutions++; return "wrong"; },
  });
  assert.equal(retry.replayed, true);
  assert.equal(retry.value, "safe");
  assert.equal(duplicateExecutions, 0);
});

test("rejects malformed operation ids before execution", async () => {
  const manager = new OperationReceiptManager();
  let executions = 0;
  await assert.rejects(manager.run({
    workspaceId: "ws_1",
    operationId: "bad",
    tool: "write",
    request: {},
    execute: async () => ++executions,
  }), /operation_id must be/);
  assert.equal(executions, 0);
});

test("durable receipt replays after a server restart without executing twice", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-op-receipt-restart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  let executions = 0;
  const input = {
    workspaceId: "ws_restart",
    operationId: op("restart-replay"),
    tool: "bash",
    request: { command: "printf once" },
    execute: async () => {
      executions += 1;
      return { result: "executed" };
    },
  };

  const first = new OperationReceiptManager({ stateDir });
  assert.deepEqual(await first.run(input), {
    value: { result: "executed" },
    replayed: false,
  });
  first.close();

  const restarted = new OperationReceiptManager({ stateDir });
  assert.deepEqual(await restarted.run({
    ...input,
    execute: async () => {
      executions += 1;
      return { result: "duplicate" };
    },
  }), {
    value: { result: "executed" },
    replayed: true,
  });
  restarted.close();
  assert.equal(executions, 1);
});

test("durable running receipt fails closed after restart instead of repeating an unknown side effect", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-op-receipt-unknown-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const bootstrap = new OperationReceiptManager({ stateDir });
  bootstrap.close();

  const database = openDatabase(stateDir);
  database.sqlite.prepare(
    `insert into operation_receipts (
       workspace_id, operation_id, tool, fingerprint, status, started_at
     ) values (?, ?, ?, ?, 'running', ?)`,
  ).run(
    "ws_unknown",
    op("unknown"),
    "bash",
    "placeholder",
    Date.now(),
  );
  database.close();

  const restarted = new OperationReceiptManager({ stateDir });
  let executions = 0;
  await assert.rejects(
    restarted.run({
      workspaceId: "ws_unknown",
      operationId: op("unknown"),
      tool: "bash",
      request: { command: "danger" },
      execute: async () => ++executions,
    }),
    /different request/,
  );
  restarted.close();
  assert.equal(executions, 0);
});

test("matching durable running receipt reports unknown outcome and never re-executes", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-op-receipt-running-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const manager = new OperationReceiptManager({ stateDir });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = manager.run({
    workspaceId: "ws_running",
    operationId: op("running"),
    tool: "bash",
    request: { command: "danger" },
    execute: async () => {
      await gate;
      return "done";
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const database = openDatabase(stateDir);
  const row = database.sqlite.prepare(
    "select fingerprint from operation_receipts where workspace_id = ? and operation_id = ?",
  ).get("ws_running", op("running")) as { fingerprint: string };
  database.close();

  const secondProcess = new OperationReceiptManager({ stateDir });
  let duplicateExecutions = 0;
  await assert.rejects(
    secondProcess.run({
      workspaceId: "ws_running",
      operationId: op("running"),
      tool: "bash",
      request: { command: "danger" },
      execute: async () => ++duplicateExecutions,
    }),
    OperationOutcomeUnknownError,
  );
  assert.ok(row.fingerprint.length > 0);
  assert.equal(duplicateExecutions, 0);
  secondProcess.close();

  release();
  assert.deepEqual(await first, { value: "done", replayed: false });
  manager.close();
});
