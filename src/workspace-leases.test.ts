import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WorkspaceBusyError,
  WorkspaceLeaseManager,
  WorkspaceTakeoverRequiredError,
} from "./workspace-leases.js";

test("workspace lease grants one controller and requires explicit stale takeover", async () => {
  let now = 1_000;
  const leases = new WorkspaceLeaseManager(100, () => now);

  const owned = leases.observeOpen("/workspace", "chat-a", "ws_a");
  assert.equal(owned.state, "owned");
  assert.equal(owned.generation, 1);
  assert.equal(owned.ownerWorkspaceId, "ws_a");

  const busy = leases.observeOpen("/workspace", "chat-b", "ws_b");
  assert.equal(busy.state, "busy");
  assert.equal(busy.stale, false);
  assert.equal(busy.retryAfterMs, 100);
  assert.equal(busy.ownerWorkspaceId, "ws_a");

  await assert.rejects(
    () => leases.runMutation("/workspace", "chat-b", async () => undefined, "ws_b"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceBusyError);
      assert.equal(error.code, "WORKSPACE_BUSY");
      assert.equal(error.retryable, true);
      return true;
    },
  );

  now += 101;
  const stale = leases.observeOpen("/workspace", "chat-b", "ws_b");
  assert.equal(stale.state, "busy");
  assert.equal(stale.stale, true);
  assert.equal(stale.retryAfterMs, 0);
  assert.equal(stale.generation, 1);

  await assert.rejects(
    () => leases.runMutation("/workspace", "chat-b", async () => undefined, "ws_b"),
    WorkspaceTakeoverRequiredError,
  );

  const takeover = leases.observeOpen("/workspace", "chat-b", "ws_b", true);
  assert.equal(takeover.state, "owned");
  assert.equal(takeover.generation, 2);
  assert.equal(takeover.ownerWorkspaceId, "ws_b");
});

test("owner activity renews a workspace lease without letting observers steal it", () => {
  let now = 2_000;
  const leases = new WorkspaceLeaseManager(100, () => now);

  leases.observeOpen("/workspace", "chat-a", "ws_a");
  now += 80;
  const renewed = leases.touchIfOwner("/workspace", "chat-a", "ws_a");
  assert.equal(renewed.state, "owned");
  assert.equal(renewed.expiresAt, 2_180);

  now += 80;
  const observer = leases.touchIfOwner("/workspace", "chat-b", "ws_b");
  assert.equal(observer.state, "busy");
  assert.equal(observer.retryAfterMs, 20);
  assert.equal(observer.stale, false);
});

test("active mutations pin the lease past the idle deadline", async () => {
  let now = 3_000;
  const leases = new WorkspaceLeaseManager(100, () => now);
  leases.observeOpen("/workspace", "chat-a", "ws_a");

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = leases.runMutation("/workspace", "chat-a", async () => {
    now += 500;
    await gate;
    return "done";
  }, "ws_a");

  await new Promise<void>((resolve) => setImmediate(resolve));
  await assert.rejects(
    () => leases.runMutation("/workspace", "chat-b", async () => undefined, "ws_b"),
    WorkspaceBusyError,
  );

  release();
  assert.equal(await running, "done");

  now += 101;
  await assert.rejects(
    () => leases.runMutation("/workspace", "chat-b", async () => "unsafe", "ws_b"),
    WorkspaceTakeoverRequiredError,
  );
  assert.equal(
    leases.observeOpen("/workspace", "chat-b", "ws_b", true).state,
    "owned",
  );
  assert.equal(
    await leases.runMutation("/workspace", "chat-b", async () => "taken-over", "ws_b"),
    "taken-over",
  );
});

test("untracked callers remain compatible unless a tracked controller owns the workspace", async () => {
  const leases = new WorkspaceLeaseManager();

  assert.equal(
    await leases.runMutation("/workspace", undefined, async () => "legacy"),
    "legacy",
  );

  leases.observeOpen("/workspace", "chat-a", "ws_a");
  await assert.rejects(
    () => leases.runMutation("/workspace", undefined, async () => undefined),
    WorkspaceBusyError,
  );
});

test("durable lease survives server restart and same controller reclaims its generation", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-lease-restart-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = 4_000;

  const first = new WorkspaceLeaseManager(100, () => now, stateDir);
  const opened = first.observeOpen("/workspace", "chat-a", "ws_a");
  assert.equal(opened.state, "owned");
  assert.equal(opened.generation, 1);
  first.close();

  now += 40;
  const restarted = new WorkspaceLeaseManager(100, () => now, stateDir);
  const reclaimed = restarted.observeOpen("/workspace", "chat-a", "ws_a");
  assert.equal(reclaimed.state, "owned");
  assert.equal(reclaimed.generation, 1);
  assert.equal(reclaimed.ownerWorkspaceId, "ws_a");

  const blocked = restarted.observeOpen("/workspace", "chat-b", "ws_b");
  assert.equal(blocked.state, "busy");
  assert.equal(blocked.stale, false);
  restarted.close();
});

test("durable stale takeover is explicit, fenced, and survives another restart", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-lease-takeover-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  let now = 5_000;

  const first = new WorkspaceLeaseManager(100, () => now, stateDir);
  assert.equal(first.observeOpen("/workspace", "chat-a", "ws_a").generation, 1);
  first.close();

  now += 101;
  const contender = new WorkspaceLeaseManager(100, () => now, stateDir);
  const stale = contender.observeOpen("/workspace", "chat-b", "ws_b");
  assert.equal(stale.state, "busy");
  assert.equal(stale.stale, true);
  assert.equal(stale.generation, 1);

  const taken = contender.observeOpen("/workspace", "chat-b", "ws_b", true);
  assert.equal(taken.state, "owned");
  assert.equal(taken.generation, 2);
  contender.close();

  const restarted = new WorkspaceLeaseManager(100, () => now, stateDir);
  const previousOwner = restarted.observeOpen("/workspace", "chat-a", "ws_a");
  assert.equal(previousOwner.state, "busy");
  assert.equal(previousOwner.generation, 2);
  assert.equal(previousOwner.ownerWorkspaceId, "ws_b");
  restarted.close();
});

test("two controllers racing for the same durable checkout produce one writer", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-workspace-lease-race-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));

  const a = new WorkspaceLeaseManager(1_000, Date.now, stateDir);
  const b = new WorkspaceLeaseManager(1_000, Date.now, stateDir);

  const first = a.observeOpen("/workspace", "chat-a", "ws_a");
  const second = b.observeOpen("/workspace", "chat-b", "ws_b");
  assert.equal(first.state, "owned");
  assert.equal(second.state, "busy");
  assert.equal(first.generation, second.generation);
  assert.equal(second.ownerWorkspaceId, "ws_a");

  a.close();
  b.close();
});

test("separate worktree roots remain independently writable", async () => {
  const leases = new WorkspaceLeaseManager();
  assert.equal(
    leases.observeOpen("/repo", "chat-a", "ws_checkout").state,
    "owned",
  );
  assert.equal(
    leases.observeOpen("/managed/worktree-a", "chat-b", "ws_worktree").state,
    "owned",
  );
  assert.equal(
    await leases.runMutation(
      "/managed/worktree-a",
      "chat-b",
      async () => "parallel",
      "ws_worktree",
    ),
    "parallel",
  );
});
