import type { ContextEngineService } from "ayati-context-engine";
import type { SkillDefinition, ToolDefinition, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  errorResultFromUnknown,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";
import {
  GIT_READ_OPERATIONS,
  MAX_GIT_READ_CHARS,
  MAX_GIT_READ_LIMIT,
  type GitReadOutput,
  type GitReadRepositoryProjection,
  type GitRepositoryIdentity,
} from "./contracts.js";
import { parseGitReadInput } from "./input.js";
import { executeGitReadOperation } from "./operation-handlers.js";
import {
  assertRepositoryIdentityUnchanged,
  resolveGitRepository,
} from "./repository-resolver.js";
import { executeProtectedWorkstreamRead } from "./workstream-adapter.js";

export interface GitReadSkillDeps {
  service: ContextEngineService;
  workstreamRoot: string;
}

export function createGitReadSkill(deps: GitReadSkillDeps): SkillDefinition {
  return {
    id: "git-read",
    version: "1.0.0",
    description: "Inspect an exact Git repository through bounded read-only operations.",
    tools: [gitReadTool(deps)],
  };
}

function gitReadTool(deps: GitReadSkillDeps): ToolDefinition {
  return {
    name: "git_read",
    description:
      "Read the state, history, references, or committed content of one exact Git repository. "
      + "Choose one structured operation; arbitrary Git arguments and every mutation or network operation are unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        repositoryPath: {
          type: "string",
          description: "Canonical absolute path to the exact Git repository root.",
        },
        operation: { type: "string", enum: [...GIT_READ_OPERATIONS] },
        revision: { type: "string", description: "Commit, branch, tag, or HEAD-like revision." },
        baseRevision: { type: "string", description: "Base revision for diff or merge_base." },
        targetRevision: { type: "string", description: "Target revision for diff or merge_base." },
        path: { type: "string", description: "Portable repository-relative path." },
        query: { type: "string", description: "Text pattern for grep." },
        diffScope: { type: "string", enum: ["commits", "working", "staged"] },
        limit: { type: "integer", minimum: 1, maximum: MAX_GIT_READ_LIMIT },
        maxChars: { type: "integer", minimum: 1, maximum: MAX_GIT_READ_CHARS },
        includePatch: { type: "boolean" },
      },
      required: ["repositoryPath", "operation"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: [...GIT_READ_OPERATIONS] },
        repository: {
          type: "object",
          properties: {
            path: { type: "string" },
            kind: { type: "string", enum: ["git_repository", "context_only_git"] },
            bare: { type: "boolean" },
            head: { type: "string" },
            branch: { type: "string" },
            health: { type: "string", enum: ["ready", "dirty_external", "recovery_required", "unavailable"] },
            access: { const: "read_only" },
          },
          required: ["path", "kind", "bare", "access"],
          additionalProperties: false,
        },
        result: { type: "object" },
        truncated: { type: "boolean" },
      },
      required: ["operation", "repository", "result", "truncated"],
      additionalProperties: false,
    },
    annotations: commonAnnotations({
      domain: "git",
      readOnly: true,
      idempotent: true,
      retrySafe: true,
    }),
    observationPolicy: {
      outputImportance: "decision_context",
      rawStorage: "always",
      maxObservationChars: MAX_GIT_READ_CHARS,
    },
    resultContract: succeededContract({
      assertions: [
        { id: "git_read_operation_returned", kind: "json_path_exists", path: "$.result.structuredContent.operation" },
        { id: "git_read_repository_returned", kind: "json_path_exists", path: "$.result.structuredContent.repository.path" },
        { id: "git_read_result_returned", kind: "json_path_exists", path: "$.result.structuredContent.result" },
      ],
    }),
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseGitReadInput(input);
      if (!parsed.ok) {
        return errorResult({
          code: "GIT_READ_INPUT_INVALID",
          message: parsed.message,
          category: "validation",
          retryable: true,
          recoverable: true,
          suggestedNextActions: ["Retry git_read with the fields accepted by the selected operation."],
        });
      }
      const startedAt = Date.now();
      try {
        const repository = await resolveGitRepository(
          parsed.value.repositoryPath,
          deps.workstreamRoot,
        );
        const executed = repository.protectedWorkstream
          ? await executeProtectedWorkstreamRead({
              service: deps.service,
              request: parsed.value,
              repository,
              context,
            })
          : {
              repository: projectRepository(repository),
              operation: await executeGitReadOperation(parsed.value, repository),
            };
        await assertRepositoryIdentityUnchanged(repository, deps.workstreamRoot);
        const output: GitReadOutput = {
          operation: parsed.value.operation,
          repository: executed.repository,
          result: executed.operation.result,
          truncated: executed.operation.truncated,
        };
        return okJsonResult({
          code: `GIT_READ_${parsed.value.operation.toUpperCase()}_SUCCEEDED`,
          message: `Completed read-only Git ${parsed.value.operation} for ${repository.path}.`,
          structuredContent: output,
          meta: {
            durationMs: Date.now() - startedAt,
            repositoryPath: repository.path,
            operation: parsed.value.operation,
            truncated: output.truncated,
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Read-only Git operation failed.";
        if (message.includes("changed during")) {
          return errorResult({
            code: "GIT_READ_REPOSITORY_CHANGED",
            message,
            category: "conflict",
            target: parsed.value.repositoryPath,
            retryable: true,
            recoverable: true,
            suggestedNextActions: ["Retry after repository activity has settled."],
            meta: { durationMs: Date.now() - startedAt },
          });
        }
        return errorResultFromUnknown({
          err,
          code: "GIT_READ_FAILED",
          fallbackMessage: "Read-only Git operation failed.",
          target: parsed.value.repositoryPath,
          suggestedNextActions: ["Check the repository path, revision, operation fields, and current read authority."],
          meta: { durationMs: Date.now() - startedAt },
        });
      }
    },
  };
}

function projectRepository(repository: GitRepositoryIdentity): GitReadRepositoryProjection {
  return {
    path: repository.path,
    kind: "git_repository",
    bare: repository.bare,
    ...(repository.head ? { head: repository.head } : {}),
    ...(repository.branch ? { branch: repository.branch } : {}),
    access: "read_only",
  };
}
