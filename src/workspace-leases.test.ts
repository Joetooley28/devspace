import assert from "node:assert/strict";
import test from "node:test";
import {
  WorkspaceBusyError,
  WorkspaceLeaseManager,
} from "./workspace-leases.js";

test("workspace lease grants one controller and blocks another until expiry", async () => {
  let now = 1_000;
  const leases = new WorkspaceLeaseManager(100, () => now);

  assert.deepEqual(leases.observeOpen("/workspace", "chat-a"), { state: "owned" });
  assert.deepEqual(leases.observeOpen("/workspace", "chat-b"), {
    state: "busy",
    retryAfterMs: 100,
  });

  await assert.rejects(
    () => leases.runMutation("/workspace", "chat-b", async () => undefined),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceBusyError);
      assert.equal(error.code, "WORKSPACE_BUSY");
      assert.equal(error.retryable, true);
      return true;
    },
  );

  now += 101;
  assert.deepEqual(leases.observeOpen("/workspace", "chat-b"), { state: "owned" });
});

test("owner activity renews a workspace lease without letting observers steal it", () => {
  let now = 2_000;
  const leases = new WorkspaceLeaseManager(100, () => now);

  leases.observeOpen("/workspace", "chat-a");
  now += 80;
  assert.deepEqual(leases.touchIfOwner("/workspace", "chat-a"), { state: "owned" });

  now += 80;
  assert.deepEqual(leases.touchIfOwner("/workspace", "chat-b"), {
    state: "busy",
    retryAfterMs: 20,
  });
});

test("active mutations pin the lease past the idle deadline", async () => {
  let now = 3_000;
  const leases = new WorkspaceLeaseManager(100, () => now);
  leases.observeOpen("/workspace", "chat-a");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = leases.runMutation("/workspace", "chat-a", async () => {
    now += 500;
    await gate;
    return "done";
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => leases.runMutation("/workspace", "chat-b", async () => undefined),
    WorkspaceBusyError,
  );

  release();
  assert.equal(await running, "done");

  now += 101;
  assert.equal(
    await leases.runMutation("/workspace", "chat-b", async () => "taken-over"),
    "taken-over",
  );
});

test("untracked callers remain compatible unless a tracked controller owns the workspace", async () => {
  const leases = new WorkspaceLeaseManager();

  assert.equal(
    await leases.runMutation("/workspace", undefined, async () => "legacy"),
    "legacy",
  );

  leases.observeOpen("/workspace", "chat-a");
  await assert.rejects(
    () => leases.runMutation("/workspace", undefined, async () => undefined),
    WorkspaceBusyError,
  );
});
