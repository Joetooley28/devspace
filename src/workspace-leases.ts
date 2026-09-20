export const DEFAULT_WORKSPACE_LEASE_TTL_MS = 5 * 60_000;

export type WorkspaceLeaseState = "owned" | "busy" | "untracked";

export interface WorkspaceLeaseStatus {
  state: WorkspaceLeaseState;
  retryAfterMs?: number;
}

interface WorkspaceLeaseRecord {
  controllerId: string;
  expiresAt: number;
  activeMutations: number;
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

export class WorkspaceLeaseManager {
  private readonly leases = new Map<string, WorkspaceLeaseRecord>();
  private readonly workspaceControllers = new Map<string, string>();

  constructor(
    private readonly ttlMs = DEFAULT_WORKSPACE_LEASE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Workspace lease TTL must be a positive integer.");
    }
  }

  observeOpen(
    workspaceKey: string,
    controllerId?: string,
    workspaceId?: string,
  ): WorkspaceLeaseStatus {
    controllerId = this.resolveController(controllerId, workspaceId);
    if (!controllerId) return { state: "untracked" };

    const current = this.current(workspaceKey);
    if (!current) {
      this.leases.set(workspaceKey, {
        controllerId,
        expiresAt: this.now() + this.ttlMs,
        activeMutations: 0,
      });
      return { state: "owned" };
    }

    if (current.controllerId === controllerId) {
      current.expiresAt = this.now() + this.ttlMs;
      return { state: "owned" };
    }

    return {
      state: "busy",
      retryAfterMs: this.retryAfter(current),
    };
  }

  touchIfOwner(
    workspaceKey: string,
    controllerId?: string,
    workspaceId?: string,
  ): WorkspaceLeaseStatus {
    controllerId = this.resolveController(controllerId, workspaceId);
    if (!controllerId) return { state: "untracked" };

    const current = this.current(workspaceKey);
    if (!current) return { state: "untracked" };
    if (current.controllerId !== controllerId) {
      return {
        state: "busy",
        retryAfterMs: this.retryAfter(current),
      };
    }

    current.expiresAt = this.now() + this.ttlMs;
    return { state: "owned" };
  }

  async runMutation<T>(
    workspaceKey: string,
    controllerId: string | undefined,
    operation: () => Promise<T>,
    workspaceId?: string,
  ): Promise<T> {
    controllerId = this.resolveController(controllerId, workspaceId);
    if (!controllerId) {
      const current = this.current(workspaceKey);
      if (current) throw new WorkspaceBusyError(this.retryAfter(current));
      return operation();
    }

    let current = this.current(workspaceKey);
    if (!current) {
      current = {
        controllerId,
        expiresAt: this.now() + this.ttlMs,
        activeMutations: 0,
      };
      this.leases.set(workspaceKey, current);
    } else if (current.controllerId !== controllerId) {
      throw new WorkspaceBusyError(this.retryAfter(current));
    }

    current.activeMutations += 1;
    current.expiresAt = this.now() + this.ttlMs;

    try {
      return await operation();
    } finally {
      current.activeMutations = Math.max(0, current.activeMutations - 1);
      current.expiresAt = this.now() + this.ttlMs;
    }
  }

  controllerForWorkspace(workspaceId: string): string | undefined {
    return this.workspaceControllers.get(workspaceId);
  }

  private resolveController(
    controllerId?: string,
    workspaceId?: string,
  ): string | undefined {
    if (controllerId) {
      if (workspaceId) this.workspaceControllers.set(workspaceId, controllerId);
      return controllerId;
    }
    return workspaceId ? this.workspaceControllers.get(workspaceId) : undefined;
  }

  private current(workspaceKey: string): WorkspaceLeaseRecord | undefined {
    const current = this.leases.get(workspaceKey);
    if (!current) return undefined;

    if (current.activeMutations === 0 && current.expiresAt <= this.now()) {
      this.leases.delete(workspaceKey);
      return undefined;
    }

    return current;
  }

  private retryAfter(record: WorkspaceLeaseRecord): number {
    if (record.activeMutations > 0) return this.ttlMs;
    return Math.max(0, record.expiresAt - this.now());
  }
}
