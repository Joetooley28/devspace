import * as z from "zod/v4";
import {
  editFileTool,
  runShellTool,
  writeFileTool,
} from "../pi-tools.js";
import {
  OPERATION_ID_DESCRIPTION,
  OPERATION_ID_PATTERN,
  runRecoverableOperation,
} from "../operation-receipts.js";
import { conversationScopeIdFromRequestMeta } from "../request-meta.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  countDiffStats,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./shared.js";

const CLAUDE_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope. For each side-effecting ${toolNames.write}, ${toolNames.edit}, or ${toolNames.shell} call, choose a fresh operation_id and reuse that same ID only for an exact retry after an unknown or lost response.`;

export function claudeInstructions({
  agents,
  skills,
}: ToolInstructionContext): string {
  return `${agents}${skills}${CLAUDE_INSTRUCTIONS}`;
}

export function registerClaudeTools(context: ToolRegistrationContext): void {
  registerClaudeMutationTools(context);
  registerShellTool(context);
}

const CLAUDE_SHELL_DESCRIPTION = "Run a shell command in a workspace with the user's local permissions.";

interface RecoverableToolResponse {
  [key: string]: unknown;
  content: ToolContent[];
  details?: unknown;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const operationIdSchema = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .describe(OPERATION_ID_DESCRIPTION);

function recoverableOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return resultOutputSchema({
    operation_id: z.string(),
    operation_replayed: z
      .boolean()
      .describe(
        "True when DevSpace returned the stored result of an earlier identical operation instead of repeating its local side effect.",
      ),
    ...extra,
  });
}

function attachRecoveryMetadata(
  response: RecoverableToolResponse,
  operationId: string,
  replayed: boolean,
): RecoverableToolResponse {
  if (!response.structuredContent) return response;
  return {
    ...response,
    structuredContent: {
      ...response.structuredContent,
      operation_id: operationId,
      operation_replayed: replayed,
    },
  };
}

function registerClaudeMutationTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, workspaceLeases } = context;

  server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description: "Create or completely overwrite a file in a workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
      },
      outputSchema: recoverableOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, ...input }, { _meta }) => {
      const workspaceId = workspace_id;
      const controllerId = conversationScopeIdFromRequestMeta(_meta)
        ?? workspaceLeases.controllerForWorkspace(workspaceId);
      const recovered = await runRecoverableOperation<RecoverableToolResponse>({
        workspaceId,
        operationId: operation_id,
        tool: toolNames.write,
        request: input,
        execute: async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return workspaceLeases.runMutation(
            workspace.canonicalRoot,
            controllerId,
            async () => {
              const startedAt = performance.now();
              const path = await workspaces.resolvePath(workspace, input.path);
              const response = await writeFileTool({ ...input, path }, { cwd: workspace.root });

              if (response.isError) {
                logFailedToolResponse(
                  config,
                  {
                    tool: toolNames.write,
                    workspaceId,
                    path: input.path,
                  },
                  response.content,
                  startedAt,
                );
                return response;
              }

              logToolCall(config, {
                tool: toolNames.write,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });

              return {
                ...response,
                structuredContent: {
                  result: contentText(response.content),
                },
              };
            },
          );
        },
      });

      return attachRecoveryMetadata(
        recovered.value,
        operation_id,
        recovered.replayed,
      );
    },
  );

  server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description:
        "Edit one file in a workspace by replacing exact text blocks. Each old_text must match a unique, non-overlapping region of the original file.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              old_text: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              new_text: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
      },
      outputSchema: recoverableOutputSchema({
        status: z.literal("applied"),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, edits, ...input }, { _meta }) => {
      const workspaceId = workspace_id;
      const controllerId = conversationScopeIdFromRequestMeta(_meta)
        ?? workspaceLeases.controllerForWorkspace(workspaceId);
      const request = { ...input, edits };
      const recovered = await runRecoverableOperation<RecoverableToolResponse>({
        workspaceId,
        operationId: operation_id,
        tool: toolNames.edit,
        request,
        execute: async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return workspaceLeases.runMutation(
            workspace.canonicalRoot,
            controllerId,
            async () => {
              const startedAt = performance.now();
              const path = await workspaces.resolvePath(workspace, input.path);
              const response = await editFileTool({
                ...input,
                path,
                edits: edits.map(({ old_text, new_text }) => ({
                  oldText: old_text,
                  newText: new_text,
                })),
              }, { cwd: workspace.root });

              if (response.isError) {
                logFailedToolResponse(
                  config,
                  {
                    tool: toolNames.edit,
                    workspaceId,
                    path: input.path,
                  },
                  response.content,
                  startedAt,
                );
                return response;
              }

              const stats = countDiffStats(
                response.details?.patch ?? response.details?.diff,
              );
              const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
              const editContent = [textBlock(editResultText)];
              logToolCall(config, {
                tool: toolNames.edit,
                workspaceId,
                path: input.path,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });

              return {
                content: editContent,
                structuredContent: {
                  status: "applied",
                  result: contentText(editContent),
                },
              };
            },
          );
        },
      });

      return attachRecoveryMetadata(
        recovered.value,
        operation_id,
        recovered.replayed,
      );
    },
  );
}

function registerShellTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces, workspaceLeases } = context;

  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: CLAUDE_SHELL_DESCRIPTION,
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        operation_id: operationIdSchema,
        command: z
          .string()
          .describe("Shell command to execute."),
        working_directory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: recoverableOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, operation_id, working_directory, ...input }, { _meta }) => {
      const workspaceId = workspace_id;
      const controllerId = conversationScopeIdFromRequestMeta(_meta)
        ?? workspaceLeases.controllerForWorkspace(workspaceId);
      const workingDirectory = working_directory;
      const recovered = await runRecoverableOperation<RecoverableToolResponse>({
        workspaceId,
        operationId: operation_id,
        tool: toolNames.shell,
        request: { ...input, working_directory: workingDirectory },
        execute: async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return workspaceLeases.runMutation(
            workspace.canonicalRoot,
            controllerId,
            async () => {
              const startedAt = performance.now();
              const cwd = await workspaces.resolveWorkingDirectory(
                workspace,
                workingDirectory,
              );
              const response = await runShellTool(input, {
                cwd,
              });

              if (response.isError) {
                logFailedToolResponse(
                  config,
                  {
                    tool: toolNames.shell,
                    workspaceId,
                    workingDirectory: workingDirectory ?? ".",
                    command: input.command,
                    commandLength: input.command.length,
                  },
                  response.content,
                  startedAt,
                );
                return response;
              }

              logToolCall(config, {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? ".",
                command: input.command,
                commandLength: input.command.length,
                success: true,
                durationMs: Math.round(performance.now() - startedAt),
              });

              return {
                ...response,
                structuredContent: {
                  result: contentText(response.content),
                },
              };
            },
          );
        },
      });

      return attachRecoveryMetadata(
        recovered.value,
        operation_id,
        recovered.replayed,
      );
    },
  );
}
