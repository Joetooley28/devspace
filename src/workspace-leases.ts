import { openDatabase, type DatabaseHandle } from "./db/client.js";

export const DEFAULT_WORKSPACE_LEASE_TTL_MS = 5 * 60_000;

export type WorkspaceLeaseState = "owned" | "busy" | "available" | "untracked";

export interface WorkspaceLeaseStatus {
  state: WorkspaceLeaseState;
  retryAfterMs?: number;
  ownerWorkspaceId?: string;
  generation?: number;
  heartbeatAt?: number;
  expiresAt?: number;
  stale?: boolean;
}

interface WorkspaceLeaseRecord {
  controllerId: string;
  workspaceId?: string;
  generation: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

interface PersistentWorkspaceLeaseRow {
  workspace_key: string;
  controller_id: string;
  workspace_id: string | null;
  generation: number;
  acquired_at: number;
  heartbeat_at: number;
  expires_at: number;
}

interface ActiveMutationRecord {
  controllerId: string;
  generation: number;
  count: number;
}

export class WorkspaceBusyError extends Error {
  readonly code = "WORKSPACE_BUSY";
  readonly retryable = true;

  constructor(readonly retryAfterMs: number) {
    super(
      "workspace_busy: another controller currently holds the write lease for this workspace. "
      + "Reads are allowed, but do not retry or start a competing mutation until the lease is released or expires."
      + (retryAfterMs > 0 ? ` Retry after approximately ${Math.ceil(retryAfterMs / 1000)} seconds.` : ""),
    );
    this.name = "WorkspaceBusyError";
  }
}

export class WorkspaceTakeoverRequiredError extends Error {
  readonly code = "WORKSPACE_TAKEOVER_REQUIRED";
  readonly retryable = false;

  constructor() {
    super(
      "workspace_takeover_required: another controller's durable write lease is stale. "
      + "Reads remain allowed, but a different controller must explicitly reopen the checkout with takeover=true before mutating it.",
    );
    this.name = "WorkspaceTakeoverRequiredError";
  }
}

export class WorkspaceLeaseManager {
  private readonly leases = new Map<string, WorkspaceLeaseRecord>();
  private readonly workspaceControllers = new Map<string, string>();
  private readonly activeMutations = new Map<string, ActiveMutationRecord>();
  private readonly database?: DatabaseHandle;

  constructor(
    private readonly ttlMs = DEFAULT_WORKSPACE_LEASE_TTL_MS,
    private readonly now: () => number = Date.now,
    stateDir?: string,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Workspace lease TTL must be a positive integer.");
    }
    if (stateDir) this.database = openDatabase(stateDir);
  }

  close(): void {
    this.database?.close();
  }

  observeOpen(
    workspaceKey: string,
    controllerId?: string,
    workspaceId?: string,
    takeover = false,
  ): WorkspaceLeaseStatus {
    controllerId = this.resolveController(controllerId, workspaceId);
    if (!controllerId) return { state: "untracked" };
    return this.database
      ? this.observePersistent(workspaceKey, controllerId, workspaceId, takeover)
      : this.observeMemory(workspaceKey, controllerId, workspaceId, takeover);
  }

  touchIfOwner(
    workspaceKey: string,
    controllerId?: string,
    workspaceId?: string,
  ): WorkspaceLeaseStatus {
    controllerId = this.resolveController(controllerId, workspaceId);
    if (!controllerId) return { state: "untracked" };
    return this.database
      ? this.touchPersistent(workspaceKey, controllerId, workspaceId)
      : this.touchMemory(workspaceKey, controllerId, workspaceId);
  }

  async runMutation<T>(
    workspaceKey: string,
    controllerId: string | undefined,
    operation: () => Promise<T>,
    workspaceId?: string,
  ): Promise<T> {
    controllerId = this.resolveController(controllerId, workspaceId);
    if (!controllerId) {
      const current = this.readRecord(workspaceKey);
      if (current) {
        if (this.isStale(workspaceKey, current)) throw new WorkspaceTakeoverRequiredError();
        throw new WorkspaceBusyError(this.retryAfter(workspaceKey, current));
      }
      return operation();
    }

    const lease = this.database
      ? this.acquirePersistentForMutation(workspaceKey, controllerId, workspaceId)
      : this.acquireMemoryForMutation(workspaceKey, controllerId, workspaceId);

    this.incrementActive(workspaceKey, controllerId, lease.generation);
    const heartbeat = this.startHeartbeat(workspaceKey, controllerId, lease.generation, workspaceId);
    try {
      return await operation();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.decrementActive(workspaceKey, controllerId, lease.generation);
      this.renewOwnedLease(workspaceKey, controllerId, lease.generation, workspaceId);
    }
  }

  controllerForWorkspace(workspaceId: string): string | undefined {
    const cached = this.workspaceControllers.get(workspaceId);
    if (cached) return cached;
    if (!this.database) return undefined;

    const binding = this.database.sqlite
      .prepare(
        `select conversation_scope_id
         from workspace_conversation_bindings
         where workspace_session_id = ?
         order by last_used_at desc
         limit 1`,
      )
      .get(workspaceId) as { conversation_scope_id: string } | undefined;
    if (binding?.conversation_scope_id) {
      this.workspaceControllers.set(workspaceId, binding.conversation_scope_id);
      return binding.conversation_scope_id;
    }

    const lease = this.database.sqlite
      .prepare(
        `select controller_id
         from workspace_write_leases
         where workspace_id = ?
         limit 1`,
      )
      .get(workspaceId) as { controller_id: string } | undefined;
    if (lease?.controller_id) {
      this.workspaceControllers.set(workspaceId, lease.controller_id);
      return lease.controller_id;
    }
    return undefined;
  }

  private observeMemory(
    workspaceKey: string,
    controllerId: string,
    workspaceId: string | undefined,
    takeover: boolean,
  ): WorkspaceLeaseStatus {
    const current = this.leases.get(workspaceKey);
    const now = this.now();
    if (!current) {
      const created = this.newRecord(controllerId, workspaceId, 1, now);
      this.leases.set(workspaceKey, created);
      return this.ownedStatus(created);
    }
    if (current.controllerId === controllerId) {
      this.renewRecord(current, workspaceId, now);
      return this.ownedStatus(current);
    }
    const stale = this.isStale(workspaceKey, current);
    if (takeover && stale) {
      const replacement = this.newRecord(
        controllerId,
        workspaceId,
        current.generation + 1,
        now,
      );
      this.leases.set(workspaceKey, replacement);
      return this.ownedStatus(replacement);
    }
    return this.busyStatus(workspaceKey, current, stale);
  }

  private observePersistent(
    workspaceKey: string,
    controllerId: string,
    workspaceId: string | undefined,
    takeover: boolean,
  ): WorkspaceLeaseStatus {
    const sqlite = this.database!.sqlite;
    const transaction = sqlite.transaction(() => {
      const current = this.readPersistentRecord(workspaceKey);
      const now = this.now();
      if (!current) {
        const created = this.newRecord(controllerId, workspaceId, 1, now);
        this.insertPersistentRecord(workspaceKey, created);
        return this.ownedStatus(created);
      }
      if (current.controllerId === controllerId) {
        this.updatePersistentOwner(workspaceKey, current.generation, controllerId, workspaceId, now);
        const renewed = { ...current };
        this.renewRecord(renewed, workspaceId, now);
        return this.ownedStatus(renewed);
      }
      const stale = this.isStale(workspaceKey, current);
      if (takeover && stale) {
        const replacement = this.newRecord(
          controllerId,
          workspaceId,
          current.generation + 1,
          now,
        );
        sqlite.prepare(
          `update workspace_write_leases
           set controller_id = ?, workspace_id = ?, generation = ?, acquired_at = ?, heartbeat_at = ?, expires_at = ?
           where workspace_key = ? and generation = ?`,
        ).run(
          replacement.controllerId,
          replacement.workspaceId ?? null,
          replacement.generation,
          replacement.acquiredAt,
          replacement.heartbeatAt,
          replacement.expiresAt,
          workspaceKey,
          current.generation,
        );
        return this.ownedStatus(replacement);
      }
      return this.busyStatus(workspaceKey, current, stale);
    });
    return transaction.immediate();
  }

  private touchMemory(
    workspaceKey: string,
    controllerId: string,
    workspaceId?: string,
  ): WorkspaceLeaseStatus {
    const current = this.leases.get(workspaceKey);
    if (!current) return { state: "available" };
    if (current.controllerId !== controllerId) {
      return this.busyStatus(workspaceKey, current, this.isStale(workspaceKey, current));
    }
    this.renewRecord(current, workspaceId, this.now());
    return this.ownedStatus(current);
  }

  private touchPersistent(
    workspaceKey: string,
    controllerId: string,
    workspaceId?: string,
  ): WorkspaceLeaseStatus {
    const current = this.readPersistentRecord(workspaceKey);
    if (!current) return { state: "available" };
    if (current.controllerId !== controllerId) {
      return this.busyStatus(workspaceKey, current, this.isStale(workspaceKey, current));
    }
    const now = this.now();
    this.updatePersistentOwner(workspaceKey, current.generation, controllerId, workspaceId, now);
    this.renewRecord(current, workspaceId, now);
    return this.ownedStatus(current);
  }

  private acquireMemoryForMutation(
    workspaceKey: string,
    controllerId: string,
    workspaceId?: string,
  ): WorkspaceLeaseRecord {
    const current = this.leases.get(workspaceKey);
    const now = this.now();
    if (!current) {
      const created = this.newRecord(controllerId, workspaceId, 1, now);
      this.leases.set(workspaceKey, created);
      return created;
    }
    if (current.controllerId !== controllerId) {
      if (this.isStale(workspaceKey, current)) throw new WorkspaceTakeoverRequiredError();
      throw new WorkspaceBusyError(this.retryAfter(workspaceKey, current));
    }
    this.renewRecord(current, workspaceId, now);
    return current;
  }

  private acquirePersistentForMutation(
    workspaceKey: string,
    controllerId: string,
    workspaceId?: string,
  ): WorkspaceLeaseRecord {
    const sqlite = this.database!.sqlite;
    const transaction = sqlite.transaction(() => {
      const current = this.readPersistentRecord(workspaceKey);
      const now = this.now();
      if (!current) {
        const created = this.newRecord(controllerId, workspaceId, 1, now);
        this.insertPersistentRecord(workspaceKey, created);
        return created;
      }
      if (current.controllerId !== controllerId) {
        if (this.isStale(workspaceKey, current)) throw new WorkspaceTakeoverRequiredError();
        throw new WorkspaceBusyError(this.retryAfter(workspaceKey, current));
      }
      this.updatePersistentOwner(workspaceKey, current.generation, controllerId, workspaceId, now);
      this.renewRecord(current, workspaceId, now);
      return current;
    });
    return transaction.immediate();
  }

  private readRecord(workspaceKey: string): WorkspaceLeaseRecord | undefined {
    return this.database
      ? this.readPersistentRecord(workspaceKey)
      : this.leases.get(workspaceKey);
  }

  private readPersistentRecord(workspaceKey: string): WorkspaceLeaseRecord | undefined {
    const row = this.database!.sqlite
      .prepare("select * from workspace_write_leases where workspace_key = ?")
      .get(workspaceKey) as PersistentWorkspaceLeaseRow | undefined;
    if (!row) return undefined;
    return {
      controllerId: row.controller_id,
      workspaceId: row.workspace_id ?? undefined,
      generation: row.generation,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    };
  }

  private insertPersistentRecord(workspaceKey: string, record: WorkspaceLeaseRecord): void {
    this.database!.sqlite.prepare(
      `insert into workspace_write_leases (
         workspace_key, controller_id, workspace_id, generation, acquired_at, heartbeat_at, expires_at
       ) values (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      workspaceKey,
      record.controllerId,
      record.workspaceId ?? null,
      record.generation,
      record.acquiredAt,
      record.heartbeatAt,
      record.expiresAt,
    );
  }

  private updatePersistentOwner(
    workspaceKey: string,
    generation: number,
    controllerId: string,
    workspaceId: string | undefined,
    now: number,
  ): boolean {
    const result = this.database!.sqlite.prepare(
      `update workspace_write_leases
       set workspace_id = coalesce(?, workspace_id), heartbeat_at = ?, expires_at = ?
       where workspace_key = ? and controller_id = ? and generation = ?`,
    ).run(
      workspaceId ?? null,
      now,
      now + this.ttlMs,
      workspaceKey,
      controllerId,
      generation,
    );
    return result.changes > 0;
  }

  private renewOwnedLease(
    workspaceKey: string,
    controllerId: string,
    generation: number,
    workspaceId?: string,
  ): void {
    const now = this.now();
    if (this.database) {
      this.updatePersistentOwner(workspaceKey, generation, controllerId, workspaceId, now);
      return;
    }
    const current = this.leases.get(workspaceKey);
    if (!current || current.controllerId !== controllerId || current.generation !== generation) return;
    this.renewRecord(current, workspaceId, now);
  }

  private startHeartbeat(
    workspaceKey: string,
    controllerId: string,
    generation: number,
    workspaceId?: string,
  ): ReturnType<typeof setInterval> | undefined {
    if (!this.database) return undefined;
    const intervalMs = Math.max(10, Math.floor(this.ttlMs / 3));
    const timer = setInterval(() => {
      this.updatePersistentOwner(workspaceKey, generation, controllerId, workspaceId, this.now());
    }, intervalMs);
    timer.unref?.();
    return timer;
  }

  private resolveController(
    controllerId?: string,
    workspaceId?: string,
  ): string | undefined {
    if (controllerId) {
      if (workspaceId) this.workspaceControllers.set(workspaceId, controllerId);
      return controllerId;
    }
    return workspaceId ? this.controllerForWorkspace(workspaceId) : undefined;
  }

  private newRecord(
    controllerId: string,
    workspaceId: string | undefined,
    generation: number,
    now: number,
  ): WorkspaceLeaseRecord {
    return {
      controllerId,
      workspaceId,
      generation,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + this.ttlMs,
    };
  }

  private renewRecord(record: WorkspaceLeaseRecord, workspaceId: string | undefined, now: number): void {
    record.workspaceId = workspaceId ?? record.workspaceId;
    record.heartbeatAt = now;
    record.expiresAt = now + this.ttlMs;
  }

  private ownedStatus(record: WorkspaceLeaseRecord): WorkspaceLeaseStatus {
    return {
      state: "owned",
      ownerWorkspaceId: record.workspaceId,
      generation: record.generation,
      heartbeatAt: record.heartbeatAt,
      expiresAt: record.expiresAt,
      stale: false,
    };
  }

  private busyStatus(
    workspaceKey: string,
    record: WorkspaceLeaseRecord,
    stale: boolean,
  ): WorkspaceLeaseStatus {
    return {
      state: "busy",
      retryAfterMs: stale ? 0 : this.retryAfter(workspaceKey, record),
      ownerWorkspaceId: record.workspaceId,
      generation: record.generation,
      heartbeatAt: record.heartbeatAt,
      expiresAt: record.expiresAt,
      stale,
    };
  }

  private isStale(workspaceKey: string, record: WorkspaceLeaseRecord): boolean {
    if (this.isLocallyActive(workspaceKey, record)) return false;
    return record.expiresAt <= this.now();
  }

  private retryAfter(workspaceKey: string, record: WorkspaceLeaseRecord): number {
    if (this.isLocallyActive(workspaceKey, record)) return this.ttlMs;
    return Math.max(0, record.expiresAt - this.now());
  }

  private incrementActive(workspaceKey: string, controllerId: string, generation: number): void {
    const current = this.activeMutations.get(workspaceKey);
    if (current && current.controllerId === controllerId && current.generation === generation) {
      current.count += 1;
      return;
    }
    this.activeMutations.set(workspaceKey, { controllerId, generation, count: 1 });
  }

  private decrementActive(workspaceKey: string, controllerId: string, generation: number): void {
    const current = this.activeMutations.get(workspaceKey);
    if (!current || current.controllerId !== controllerId || current.generation !== generation) return;
    current.count -= 1;
    if (current.count <= 0) this.activeMutations.delete(workspaceKey);
  }

  private isLocallyActive(workspaceKey: string, record: WorkspaceLeaseRecord): boolean {
    const active = this.activeMutations.get(workspaceKey);
    return Boolean(
      active
      && active.count > 0
      && active.controllerId === record.controllerId
      && active.generation === record.generation,
    );
  }
}
