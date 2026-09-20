import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import {
  OPERATION_ID_DESCRIPTION,
  OPERATION_ID_PATTERN,
} from "../operation-receipts.js";
import { conversationScopeIdFromRequestMeta } from "../request-meta.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolLogFields,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope. For each side-effecting apply_patch, exec_command, or write_stdin call, choose a fresh operation_id and reuse that same ID only for an exact retry after an unknown or lost response.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

const operationIdSchema = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .describe(OPERATION_ID_DESCRIPTION);

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return snapshot.output
    ? `${snapshot.output.replace(/\n$/, "")}\n${status}`
    : status;
}

function processOutputSchema(): z.ZodRawShape {
  return resultOutputSchema({
    operation_id: z.string(),
    operation_replayed: z.boolean(),
    session_id: z.number().optional(),
    running: z.boolean(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    wall_time_ms: z.number().nonnegative(),
    output_truncated: z.boolean(),
  });
}

function processToolResponse(
  snapshot: ProcessSnapshot,
  operationId: string,
  replayed: boolean,
) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      result,
      operation_id: operationId,
      operation_replayed: replayed,
      session_id: snapshot.sessionId,
      running: snapshot.running,
      exit_code: snapshot.exitCode,
      signal: snapshot.signal,
      wall_time_ms: snapshot.wallTimeMs,
      output_truncated: snapshot.outputTruncated,
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, workspaceLeases, operationReceipts } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch to add, overwrite, update, delete, or move workspace files. Paths must be relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema({
        operation_id: z.string(),
        operation_replayed: z.boolean(),
        additions: z.number(),
        removals: z.number(),
        files: z.array(
          z.object({
            path: z.string(),
            previous_path: z.string().optional(),
            operation: z.enum(["add", "update", "delete", "move"]),
          }),
        ),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, patch }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const controllerId = conversationScopeIdFromRequestMeta(_meta)
        ?? workspaceLeases.controllerForWorkspace(workspaceId);
      const recovered = await operationReceipts.run({
        workspaceId,
        operationId: operation_id,
        tool: "apply_patch",
        request: { patch },
        execute: async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return runLoggedToolOperation(
            config,
            { tool: "apply_patch", workspaceId },
            startedAt,
            () => workspaceLeases.runMutation(
              workspace.canonicalRoot,
              controllerId,
              () => applyPatch(workspace.root, patch),
              workspaceId,
            ),
          );
        },
      });
      const applied = recovered.value;
      const paths = applied.files.map((file) => file.path).join(", ");
      const result = `Applied patch to ${applied.files.length} file(s): ${paths}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
          operation_id,
          operation_replayed: recovered.replayed,
          additions: applied.additions,
          removals: applied.removals,
          files: applied.files.map(({ previousPath, ...file }) => ({
            ...file,
            previous_path: previousPath,
          })),
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const {
    server,
    config,
    workspaces,
    workspaceLeases,
    operationReceipts,
    processSessions,
  } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a shell command in a workspace with the user's local permissions. Returns the result when it exits during the yield window, otherwise returns a session_id for write_stdin.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY width. Defaults to 80."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Initial PTY height. Defaults to 24."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000, maximum 12000. Use write_stdin for work that runs longer.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      operation_id,
      cmd,
      tty,
      columns,
      rows,
      working_directory,
      yield_time_ms,
      max_output_tokens,
    }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = working_directory;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const controllerId = conversationScopeIdFromRequestMeta(_meta)
        ?? workspaceLeases.controllerForWorkspace(workspaceId);
      const recovered = await operationReceipts.run<ProcessSnapshot>({
        workspaceId,
        operationId: operation_id,
        tool: "exec_command",
        request: {
          cmd,
          tty,
          columns,
          rows,
          working_directory: workingDirectory,
          yield_time_ms: yieldTimeMs,
          max_output_tokens: maxOutputTokens,
        },
        execute: async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return runLoggedToolOperation(
            config,
            {
              tool: "exec_command",
              workspaceId,
              workingDirectory: workingDirectory ?? ".",
              command: cmd,
              commandLength: cmd.length,
            },
            startedAt,
            () => workspaceLeases.runMutation(
              workspace.canonicalRoot,
              controllerId,
              async () => {
                const cwd = await workspaces.resolveWorkingDirectory(
                  workspace,
                  workingDirectory,
                );
                return processSessions.start({
                  workspaceId,
                  command: cmd,
                  cwd,
                  workspaceRoot: workspace.root,
                  tty,
                  columns,
                  rows,
                  yieldTimeMs,
                  maxOutputTokens,
                });
              },
              workspaceId,
            ),
            processLogFields,
          );
        },
      });

      return processToolResponse(recovered.value, operation_id, recovered.replayed);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        operation_id: operationIdSchema,
        session_id: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        columns: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this width."),
        rows: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .describe("Resize a PTY to this height."),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Maximum 12000; polling defaults to 5000 and interactive writes to 250.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      operation_id,
      session_id,
      chars,
      columns,
      rows,
      yield_time_ms,
      max_output_tokens,
    }, { _meta }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const controllerId = conversationScopeIdFromRequestMeta(_meta)
        ?? workspaceLeases.controllerForWorkspace(workspaceId);
      const recovered = await operationReceipts.run<ProcessSnapshot>({
        workspaceId,
        operationId: operation_id,
        tool: "write_stdin",
        request: {
          session_id: sessionId,
          chars,
          columns,
          rows,
          yield_time_ms: yieldTimeMs,
          max_output_tokens: maxOutputTokens,
        },
        execute: async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return runLoggedToolOperation(
            config,
            { tool: "write_stdin", workspaceId },
            startedAt,
            () => workspaceLeases.runMutation(
              workspace.canonicalRoot,
              controllerId,
              () => processSessions.write({
                workspaceId,
                sessionId,
                chars,
                columns,
                rows,
                yieldTimeMs,
                maxOutputTokens,
              }),
              workspaceId,
            ),
            processLogFields,
          );
        },
      });

      return processToolResponse(recovered.value, operation_id, recovered.replayed);
    },
  );
}

export function processLogFields(result: ProcessSnapshot): Partial<ToolLogFields> {
  const success = result.running || (!result.signal && result.exitCode === 0);
  const termination = result.signal
    ? `Process terminated by signal ${result.signal}.`
    : `Process exited with code ${result.exitCode ?? "unknown"}.`;
  return {
    sessionId: result.sessionId,
    running: result.running,
    exitCode: result.exitCode,
    success,
    ...(success ? {} : { error: termination }),
  };
}
