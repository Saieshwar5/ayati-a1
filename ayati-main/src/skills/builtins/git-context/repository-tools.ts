import type { ContextEngineService } from "ayati-context-engine";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";

export function createWorkstreamRepositoryTools(
  service: ContextEngineService,
): ToolDefinition[] {
  return [repositoryLogTool(service), repositoryShowTool(service), repositoryDiffTool(service)];
}

function repositoryLogTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "git_context_log",
    description:
      "Read recent commits from the exact managed workstream context repository. "
      + "Use when a continuation is ambiguous and recent durable mutation history may identify the workstream or request.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryPath: {
          type: "string",
          description: "Exact context.run.workstreamRepository.path from current context.",
        },
        limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
      },
      required: ["repositoryPath"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        repository: repositorySchema(),
        commits: { type: "array", items: { type: "object" } },
        count: { type: "integer" },
        hasMore: { type: "boolean" },
      },
      required: ["repository", "commits", "count", "hasMore"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract({
      assertions: [{
        id: "workstream_repository_log_returned",
        kind: "json_path_exists",
        path: "$.result.structuredContent.commits",
      }],
    }),
    async execute(input, context): Promise<ToolResult> {
      const parsed = commonInput(input, context);
      if ("ok" in parsed) return parsed;
      const limit = optionalInteger(parsed.record["limit"]);
      if (parsed.record["limit"] !== undefined && (!limit || limit < 1 || limit > 20)) {
        return repositoryError("limit must be an integer between 1 and 20.");
      }
      try {
        const result = await service.readWorkstreamRepositoryLog({
          requestId: parsed.requestId + ":log",
          runId: parsed.runId,
          repositoryPath: parsed.repositoryPath,
          ...(limit ? { limit } : {}),
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_LOG_READ",
          message: `Read ${result.count} recent workstream repository commits.`,
          structuredContent: result,
        });
      } catch (error) {
        return repositoryError(errorMessage(error));
      }
    },
  };
}

function repositoryShowTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "git_context_show",
    description:
      "Read one exact managed workstream repository commit and its changed notebook paths. "
      + "This is durable navigation evidence, not authority to mutate a workstream.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryPath: {
          type: "string",
          description: "Exact context.run.workstreamRepository.path from current context.",
        },
        commit: { type: "string", pattern: "^[a-f0-9]{7,40}$" },
      },
      required: ["repositoryPath", "commit"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        repository: repositorySchema(),
        commit: { type: "object" },
        changedPaths: { type: "array", items: { type: "object" } },
      },
      required: ["repository", "commit", "changedPaths"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract({
      assertions: [{
        id: "workstream_repository_commit_returned",
        kind: "json_path_exists",
        path: "$.result.structuredContent.commit.commit",
      }],
    }),
    async execute(input, context): Promise<ToolResult> {
      const parsed = commonInput(input, context);
      if ("ok" in parsed) return parsed;
      const commit = optionalString(parsed.record, "commit");
      if (!commit || !/^[a-f0-9]{7,40}$/.test(commit)) {
        return repositoryError("commit must be a 7 to 40 character lowercase Git SHA.");
      }
      try {
        const result = await service.readWorkstreamRepositoryCommit({
          requestId: parsed.requestId + ":show",
          runId: parsed.runId,
          repositoryPath: parsed.repositoryPath,
          commit,
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_COMMIT_READ",
          message: `Read workstream repository commit ${result.commit.commit}.`,
          structuredContent: result,
        });
      } catch (error) {
        return repositoryError(errorMessage(error));
      }
    },
  };
}

function repositoryDiffTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "git_context_diff",
    description:
      "Read a bounded committed diff between two exact managed workstream repository commits. "
      + "Use only when commit receipts do not provide enough continuation detail.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryPath: {
          type: "string",
          description: "Exact context.run.workstreamRepository.path from current context.",
        },
        from: { type: "string", pattern: "^[a-f0-9]{7,40}$" },
        to: { type: "string", pattern: "^[a-f0-9]{7,40}$" },
        maxChars: { type: "integer", minimum: 1, maximum: 100000, default: 40000 },
      },
      required: ["repositoryPath", "from", "to"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        repository: repositorySchema(),
        from: { type: "string" },
        to: { type: "string" },
        changedPaths: { type: "array", items: { type: "object" } },
        patch: { type: "string" },
        totalPatchChars: { type: "integer" },
        truncated: { type: "boolean" },
      },
      required: [
        "repository",
        "from",
        "to",
        "changedPaths",
        "patch",
        "totalPatchChars",
        "truncated",
      ],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract({
      assertions: [{
        id: "workstream_repository_diff_returned",
        kind: "json_path_exists",
        path: "$.result.structuredContent.changedPaths",
      }],
    }),
    async execute(input, context): Promise<ToolResult> {
      const parsed = commonInput(input, context);
      if ("ok" in parsed) return parsed;
      const from = optionalString(parsed.record, "from");
      const to = optionalString(parsed.record, "to");
      const maxChars = optionalInteger(parsed.record["maxChars"]);
      if (!from || !/^[a-f0-9]{7,40}$/.test(from)
        || !to || !/^[a-f0-9]{7,40}$/.test(to)) {
        return repositoryError("from and to must be 7 to 40 character lowercase Git SHAs.");
      }
      if (parsed.record["maxChars"] !== undefined
        && (!maxChars || maxChars < 1 || maxChars > 100_000)) {
        return repositoryError("maxChars must be an integer between 1 and 100000.");
      }
      try {
        const result = await service.readWorkstreamRepositoryDiff({
          requestId: parsed.requestId + ":diff",
          runId: parsed.runId,
          repositoryPath: parsed.repositoryPath,
          from,
          to,
          ...(maxChars ? { maxChars } : {}),
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_DIFF_READ",
          message: `Read the committed workstream repository diff from ${result.from} to ${result.to}.`,
          structuredContent: result,
        });
      } catch (error) {
        return repositoryError(errorMessage(error));
      }
    },
  };
}

function commonInput(input: unknown, context?: ToolExecutionContext): {
  record: Record<string, unknown>;
  repositoryPath: string;
  runId: string;
  requestId: string;
} | ToolResult {
  const record = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const repositoryPath = optionalString(record, "repositoryPath");
  const runId = context?.runId?.trim();
  const callId = context?.callId?.trim();
  if (!repositoryPath || !runId || !callId) {
    return repositoryError(
      "Workstream repository inspection requires the projected repositoryPath and current run identity.",
    );
  }
  return { record, repositoryPath, runId, requestId: `${runId}:${callId}` };
}

function repositorySchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      path: { type: "string" },
      branch: { const: "main" },
      head: { type: "string" },
      health: { enum: ["ready", "dirty_external", "recovery_required", "unavailable"] },
      kind: { const: "context_only_git" },
      access: { const: "read_only" },
    },
    required: ["path", "branch", "head", "health", "kind", "access"],
    additionalProperties: false,
  };
}

function readAnnotations() {
  return commonAnnotations({
    domain: "git_context",
    readOnly: true,
    idempotent: true,
    retrySafe: true,
  });
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function repositoryError(message: string): ToolResult {
  return errorResult({
    code: "GIT_CONTEXT_REPOSITORY_READ_FAILED",
    message,
    category: "conflict",
    retryable: false,
    suggestedNextActions: [
      "Use the exact projected workstream repository path, then inspect current workstream state before routing.",
    ],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
