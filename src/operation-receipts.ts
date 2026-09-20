import { createHash } from "node:crypto";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const OPERATION_ID_DESCRIPTION =
  "Stable ID for this logical side-effecting operation. Use a fresh ID for each new operation. Reuse the same ID only when retrying the exact same request after an unknown or lost response.";

const DEFAULT_RECEIPT_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_RECEIPTS = 1_000;
const DEFAULT_MAX_TOMBSTONES = 100_000;

type StoredReceipt = {
  fingerprint: string;
  promise: Promise<unknown>;
  settledAt?: number;
};

type Tombstone = {
  fingerprint: string;
};

interface PersistentReceiptRow {
  fingerprint: string;
  status: string;
  result_json: string | null;
  error_message: string | null;
  error_code: string | null;
  error_retryable: string | null;
  settled_at: number | null;
}

export interface OperationReceiptManagerOptions {
  receiptTtlMs?: number;
  maxReceipts?: number;
  maxTombstones?: number;
  now?: () => number;
  stateDir?: string;
}

export interface RunRecoverableOperationInput<T> {
  workspaceId: string;
  operationId: string;
  tool: string;
  request: unknown;
  execute: () => Promise<T>;
}

export interface RecoverableOperationResult<T> {
  value: T;
  replayed: boolean;
}

export class OperationOutcomeUnknownError extends Error {
  readonly code = "OPERATION_OUTCOME_UNKNOWN";
  readonly retryable = false;

  constructor(operationId: string) {
    super(
      `Operation ${operationId} has a durable running receipt from an earlier DevSpace process. `
      + "Its response was not durably completed, so the side effect may already have happened. "
      + "DevSpace will not execute it again; inspect current state and use a new operation_id only for a genuinely new action.",
    );
    this.name = "OperationOutcomeUnknownError";
  }
}

export class OperationReceiptManager {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly tombstones = new Map<string, Tombstone>();
  private readonly persistentInflight = new Map<string, StoredReceipt>();
  private readonly receiptTtlMs: number;
  private readonly maxReceipts: number;
  private readonly maxTombstones: number;
  private readonly now: () => number;
  private readonly database?: DatabaseHandle;

  constructor(options: OperationReceiptManagerOptions = {}) {
    this.receiptTtlMs = options.receiptTtlMs ?? DEFAULT_RECEIPT_TTL_MS;
    this.maxReceipts = options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    this.maxTombstones = options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES;
    this.now = options.now ?? Date.now;

    if (!Number.isFinite(this.receiptTtlMs) || this.receiptTtlMs < 0) {
      throw new Error("Operation receipt TTL must be a non-negative number.");
    }
    if (!Number.isInteger(this.maxReceipts) || this.maxReceipts < 1) {
      throw new Error("Operation receipt capacity must be a positive integer.");
    }
    if (!Number.isInteger(this.maxTombstones) || this.maxTombstones < 1) {
      throw new Error("Operation tombstone capacity must be a positive integer.");
    }
    if (options.stateDir) this.database = openDatabase(options.stateDir);
  }

  close(): void {
    this.database?.close();
  }

  async run<T>(input: RunRecoverableOperationInput<T>): Promise<RecoverableOperationResult<T>> {
    validateOperationId(input.operationId);
    return this.database
      ? this.runPersistent(input)
      : this.runMemory(input);
  }

  private async runMemory<T>(
    input: RunRecoverableOperationInput<T>,
  ): Promise<RecoverableOperationResult<T>> {
    const key = receiptKey(input.workspaceId, input.operationId);
    const fingerprint = requestFingerprint(input.tool, input.request);

    const existing = this.receipts.get(key);
    if (existing) {
      assertFingerprintMatches(input.operationId, existing.fingerprint, fingerprint);
      return {
        value: await existing.promise as T,
        replayed: true,
      };
    }

    const tombstone = this.tombstones.get(key);
    if (tombstone) {
      assertFingerprintMatches(input.operationId, tombstone.fingerprint, fingerprint);
      throw expiredReceiptError(input.operationId);
    }

    this.compactExpiredMemoryReceipts();

    const compactedTombstone = this.tombstones.get(key);
    if (compactedTombstone) {
      assertFingerprintMatches(input.operationId, compactedTombstone.fingerprint, fingerprint);
      throw expiredReceiptError(input.operationId);
    }

    if (this.receipts.size >= this.maxReceipts) {
      throw new Error(
        "Operation receipt capacity reached. Refusing a new side-effecting operation rather than evicting a receipt that may still be needed for safe retry.",
      );
    }

    const stored: StoredReceipt = {
      fingerprint,
      promise: Promise.resolve().then(input.execute),
    };
    this.receipts.set(key, stored);
    void stored.promise.then(
      () => {
        stored.settledAt = this.now();
      },
      () => {
        stored.settledAt = this.now();
      },
    );

    return {
      value: await stored.promise as T,
      replayed: false,
    };
  }

  private async runPersistent<T>(
    input: RunRecoverableOperationInput<T>,
  ): Promise<RecoverableOperationResult<T>> {
    const key = receiptKey(input.workspaceId, input.operationId);
    const fingerprint = requestFingerprint(input.tool, input.request);

    const inFlight = this.persistentInflight.get(key);
    if (inFlight) {
      assertFingerprintMatches(input.operationId, inFlight.fingerprint, fingerprint);
      return {
        value: await inFlight.promise as T,
        replayed: true,
      };
    }

    const existing = this.readOrCreatePersistentReceipt(input, fingerprint);
    if (existing) {
      assertFingerprintMatches(input.operationId, existing.fingerprint, fingerprint);
      return this.replayPersistentReceipt<T>(input.operationId, existing);
    }

    const stored: StoredReceipt = {
      fingerprint,
      promise: Promise.resolve()
        .then(input.execute)
        .then(
          (value) => {
            this.persistSuccess(input.workspaceId, input.operationId, fingerprint, value);
            return value;
          },
          (error: unknown) => {
            this.persistFailure(input.workspaceId, input.operationId, fingerprint, error);
            throw error;
          },
        ),
    };
    this.persistentInflight.set(key, stored);

    try {
      return {
        value: await stored.promise as T,
        replayed: false,
      };
    } finally {
      if (this.persistentInflight.get(key) === stored) {
        this.persistentInflight.delete(key);
      }
    }
  }

  private readOrCreatePersistentReceipt(
    input: RunRecoverableOperationInput<unknown>,
    fingerprint: string,
  ): PersistentReceiptRow | undefined {
    const sqlite = this.database!.sqlite;
    const transaction = sqlite.transaction(() => {
      this.compactExpiredPersistentReceipts();

      const existing = sqlite.prepare(
        `select fingerprint, status, result_json, error_message, error_code, error_retryable, settled_at
         from operation_receipts
         where workspace_id = ? and operation_id = ?`,
      ).get(input.workspaceId, input.operationId) as PersistentReceiptRow | undefined;
      if (existing) return existing;

      const count = sqlite.prepare("select count(*) as count from operation_receipts")
        .get() as { count: number };
      if (count.count >= this.maxTombstones) {
        throw new Error(
          "Operation receipt capacity reached. Refusing a new side-effecting operation rather than deleting durable retry history.",
        );
      }

      sqlite.prepare(
        `insert into operation_receipts (
           workspace_id, operation_id, tool, fingerprint, status, started_at
         ) values (?, ?, ?, ?, 'running', ?)`,
      ).run(
        input.workspaceId,
        input.operationId,
        input.tool,
        fingerprint,
        this.now(),
      );
      return undefined;
    });
    return transaction.immediate();
  }

  private replayPersistentReceipt<T>(
    operationId: string,
    receipt: PersistentReceiptRow,
  ): RecoverableOperationResult<T> {
    switch (receipt.status) {
      case "completed": {
        if (receipt.result_json === null) {
          throw new Error(`Operation ${operationId} completed but its durable result is unavailable.`);
        }
        const decoded = JSON.parse(receipt.result_json) as { value?: T };
        return { value: decoded.value as T, replayed: true };
      }
      case "failed":
        throw recoveredFailure(receipt);
      case "tombstone":
        throw expiredReceiptError(operationId);
      case "running":
        throw new OperationOutcomeUnknownError(operationId);
      default:
        throw new Error(`Operation ${operationId} has unknown durable receipt state: ${receipt.status}.`);
    }
  }

  private persistSuccess<T>(
    workspaceId: string,
    operationId: string,
    fingerprint: string,
    value: T,
  ): void {
    let resultJson: string;
    try {
      resultJson = JSON.stringify({ value });
    } catch (cause) {
      this.persistFailure(workspaceId, operationId, fingerprint, cause);
      throw new Error(
        `Operation ${operationId} executed but its result could not be serialized for durable replay. The receipt was failed closed.`,
        { cause },
      );
    }

    const result = this.database!.sqlite.prepare(
      `update operation_receipts
       set status = 'completed', result_json = ?, error_message = null, error_code = null,
           error_retryable = null, settled_at = ?
       where workspace_id = ? and operation_id = ? and fingerprint = ? and status = 'running'`,
    ).run(
      resultJson,
      this.now(),
      workspaceId,
      operationId,
      fingerprint,
    );
    if (result.changes !== 1) {
      throw new Error(
        `Operation ${operationId} executed but its durable receipt could not be finalized. Refusing unsafe replay.`,
      );
    }
  }

  private persistFailure(
    workspaceId: string,
    operationId: string,
    fingerprint: string,
    error: unknown,
  ): void {
    const detail = persistedError(error);
    this.database!.sqlite.prepare(
      `update operation_receipts
       set status = 'failed', result_json = null, error_message = ?, error_code = ?,
           error_retryable = ?, settled_at = ?
       where workspace_id = ? and operation_id = ? and fingerprint = ? and status = 'running'`,
    ).run(
      detail.message,
      detail.code ?? null,
      detail.retryable === undefined ? null : String(detail.retryable),
      this.now(),
      workspaceId,
      operationId,
      fingerprint,
    );
  }

  private compactExpiredMemoryReceipts(): void {
    const now = this.now();
    for (const [key, receipt] of this.receipts) {
      if (receipt.settledAt === undefined || now - receipt.settledAt < this.receiptTtlMs) {
        continue;
      }
      if (this.tombstones.size >= this.maxTombstones) {
        throw new Error(
          "Operation tombstone capacity reached. Refusing new side-effecting operations until DevSpace is restarted so an old operation ID cannot be silently reused.",
        );
      }
      this.receipts.delete(key);
      this.tombstones.set(key, { fingerprint: receipt.fingerprint });
    }
  }

  private compactExpiredPersistentReceipts(): void {
    const cutoff = this.now() - this.receiptTtlMs;
    this.database!.sqlite.prepare(
      `update operation_receipts
       set status = 'tombstone', result_json = null, error_message = null,
           error_code = null, error_retryable = null
       where status in ('completed', 'failed') and settled_at is not null and settled_at <= ?`,
    ).run(cutoff);
  }
}

const defaultOperationReceiptManager = new OperationReceiptManager();

export async function runRecoverableOperation<T>(
  input: RunRecoverableOperationInput<T>,
): Promise<RecoverableOperationResult<T>> {
  return defaultOperationReceiptManager.run(input);
}

function receiptKey(workspaceId: string, operationId: string): string {
  return `${workspaceId}\u0000${operationId}`;
}

function requestFingerprint(tool: string, request: unknown): string {
  return createHash("sha256")
    .update(tool)
    .update("\u0000")
    .update(canonicalJson(request))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

function validateOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error(
      "operation_id must be 8-128 characters and contain only letters, digits, '.', '_', ':', or '-', starting with a letter or digit.",
    );
  }
}

function assertFingerprintMatches(
  operationId: string,
  expected: string,
  actual: string,
): void {
  if (expected !== actual) {
    throw new Error(
      `Operation ${operationId} was already used for a different request. Reuse an operation_id only for an exact retry of the same tool call.`,
    );
  }
}

function expiredReceiptError(operationId: string): Error {
  return new Error(
    `Operation ${operationId} was already executed, but its stored result has expired. Do not execute it again; inspect current state and use a new operation_id for any new action.`,
  );
}

function persistedError(error: unknown): {
  message: string;
  code?: string;
  retryable?: boolean;
} {
  if (typeof error === "object" && error !== null) {
    const detail = error as Record<string, unknown>;
    return {
      message: error instanceof Error ? error.message : String(error),
      code: typeof detail.code === "string" ? detail.code : undefined,
      retryable: typeof detail.retryable === "boolean" ? detail.retryable : undefined,
    };
  }
  return { message: String(error) };
}

function recoveredFailure(receipt: PersistentReceiptRow): Error {
  const error = new Error(receipt.error_message ?? "The earlier operation failed.");
  error.name = "RecoveredOperationError";
  if (receipt.error_code !== null) {
    Object.assign(error, { code: receipt.error_code });
  }
  if (receipt.error_retryable !== null) {
    Object.assign(error, { retryable: receipt.error_retryable === "true" });
  }
  return error;
}
