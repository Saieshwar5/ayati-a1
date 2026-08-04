import type { ContextEngineService, WorkstreamRepositoryProjection } from "ayati-context-engine";
import type { ToolExecutionContext } from "../../types.js";
import type {
  GitReadInput,
  GitReadOperationResult,
  GitReadRepositoryProjection,
  GitRepositoryIdentity,
} from "./contracts.js";
import {
  executeGitReadOperation,
  resolveCommitRevision,
} from "./operation-handlers.js";

export async function executeProtectedWorkstreamRead(input: {
  service: ContextEngineService;
  request: GitReadInput;
  repository: GitRepositoryIdentity;
  context?: ToolExecutionContext;
}): Promise<{
  repository: GitReadRepositoryProjection;
  operation: GitReadOperationResult;
}> {
  const identity = requireRunIdentity(input.context);
  if (input.request.operation === "log") {
    if ((input.request.limit ?? 10) > 20) {
      throw new Error("The managed workstream repository log limit may not exceed 20.");
    }
    const result = await input.service.readWorkstreamRepositoryLog({
      requestId: requestId(identity, "log"),
      runId: identity.runId,
      repositoryPath: input.repository.path,
      ...(input.request.limit ? { limit: input.request.limit } : {}),
      at: new Date().toISOString(),
    });
    return {
      repository: projectManagedRepository(result.repository),
      operation: {
        result: {
          commits: result.commits,
          count: result.count,
          hasMore: result.hasMore,
        },
        truncated: result.hasMore,
      },
    };
  }

  if (input.request.operation === "show") {
    const commit = await resolveCommitRevision(
      input.repository.path,
      input.request.revision,
    );
    const result = await input.service.readWorkstreamRepositoryCommit({
      requestId: requestId(identity, "show"),
      runId: identity.runId,
      repositoryPath: input.repository.path,
      commit,
      at: new Date().toISOString(),
    });
    if (input.request.includePatch === false) {
      return {
        repository: projectManagedRepository(result.repository),
        operation: {
          result: { commit: result.commit, changedPaths: result.changedPaths },
          truncated: false,
        },
      };
    }
    const generic = await executeGitReadOperation(
      { ...input.request, revision: commit },
      input.repository,
    );
    return {
      repository: projectManagedRepository(result.repository),
      operation: {
        result: {
          commit: result.commit,
          changedPaths: result.changedPaths,
          ...pickPatch(generic.result),
        },
        truncated: generic.truncated,
      },
    };
  }

  if (input.request.operation === "diff") {
    const scope = input.request.diffScope ?? "commits";
    if (scope !== "commits") {
      throw new Error("The managed workstream repository supports committed diffs only.");
    }
    const [from, to] = await Promise.all([
      resolveCommitRevision(input.repository.path, input.request.baseRevision),
      resolveCommitRevision(input.repository.path, input.request.targetRevision),
    ]);
    const result = await input.service.readWorkstreamRepositoryDiff({
      requestId: requestId(identity, "diff"),
      runId: identity.runId,
      repositoryPath: input.repository.path,
      from,
      to,
      ...(input.request.maxChars ? { maxChars: input.request.maxChars } : {}),
      at: new Date().toISOString(),
    });
    return {
      repository: projectManagedRepository(result.repository),
      operation: {
        result: {
          scope: "commits",
          baseRevision: result.from,
          targetRevision: result.to,
          changedPaths: result.changedPaths,
          patch: result.patch,
          totalPatchChars: result.totalPatchChars,
        },
        truncated: result.truncated,
      },
    };
  }

  const validation = await input.service.readWorkstreamRepositoryLog({
    requestId: requestId(identity, "validate"),
    runId: identity.runId,
    repositoryPath: input.repository.path,
    limit: 1,
    at: new Date().toISOString(),
  });
  const operation = await executeGitReadOperation(input.request, input.repository);
  return {
    repository: projectManagedRepository(validation.repository),
    operation,
  };
}

function projectManagedRepository(
  repository: WorkstreamRepositoryProjection,
): GitReadRepositoryProjection {
  return {
    path: repository.path,
    kind: "context_only_git",
    bare: false,
    head: repository.head,
    branch: repository.branch,
    health: repository.health,
    access: "read_only",
  };
}

function requireRunIdentity(context?: ToolExecutionContext): {
  runId: string;
  callId: string;
} {
  const runId = context?.runId?.trim();
  const callId = context?.callId?.trim();
  if (!runId || !callId) {
    throw new Error("Managed workstream repository reads require current run and call identity.");
  }
  return { runId, callId };
}

function requestId(
  identity: { runId: string; callId: string },
  suffix: string,
): string {
  return `${identity.runId}:${identity.callId}:git-read:${suffix}`;
}

function pickPatch(result: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof result["patch"] === "string" ? { patch: result["patch"] } : {}),
    ...(typeof result["totalPatchChars"] === "number"
      ? { totalPatchChars: result["totalPatchChars"] }
      : {}),
  };
}
