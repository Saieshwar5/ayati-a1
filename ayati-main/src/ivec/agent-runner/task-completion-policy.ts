import { lstat } from "node:fs/promises";
import { isAbsolute, normalize, sep } from "node:path";
import { getWorkspaceRoot, isWithinWorkspace, resolveWorkspacePath } from "../../skills/workspace-paths.js";
import type { LoopState, WorkState } from "../types.js";
import type { AgentTaskCompletionRequest, TaskCompletionAssetInput } from "./decision.js";

export type TaskCompletionFailureCode =
  | "NO_ACTIVE_TASK_RUN"
  | "TASK_ALREADY_COMPLETED"
  | "COMPLETION_EVIDENCE_MISSING"
  | "ACTIVE_BLOCKERS_REMAIN"
  | "USER_INPUT_REQUIRED"
  | "INVALID_COMPLETION_SUMMARY"
  | "DUPLICATE_COMPLETION_ASSET"
  | "INVALID_ASSET_PATH"
  | "REQUIRED_ASSET_MISSING"
  | "ASSET_KIND_MISMATCH"
  | "ASSET_MUTATION_NOT_VERIFIED"
  | "UNRESOLVED_TOOL_FAILURE";

export interface TaskCompletionFailure {
  code: TaskCompletionFailureCode;
  message: string;
  path?: string;
}

export interface VerifiedCompletionAsset extends TaskCompletionAssetInput {
  resolvedPath: string;
}

export type TaskCompletionEvaluation =
  | {
      accepted: true;
      code: "TASK_COMPLETION_ACCEPTED";
      summary: string;
      assets: VerifiedCompletionAsset[];
      nextWorkState: WorkState;
    }
  | {
      accepted: false;
      code: "TASK_COMPLETION_REJECTED";
      failures: TaskCompletionFailure[];
      nextWorkState: WorkState;
    };

export function isTaskCompletionAvailable(state: LoopState): boolean {
  return state.runClass === "task"
    && Boolean(state.runId)
    && state.workState.status === "not_done";
}

export async function evaluateTaskCompletion(
  state: LoopState,
  request: AgentTaskCompletionRequest,
): Promise<TaskCompletionEvaluation> {
  const failures: TaskCompletionFailure[] = [];
  const summary = request.summary.replace(/\s+/g, " ").trim();

  if (state.runClass !== "task" || !state.runId) {
    failures.push({ code: "NO_ACTIVE_TASK_RUN", message: "Task completion requires an active task run." });
  }
  if (state.workState.status === "done") {
    failures.push({ code: "TASK_ALREADY_COMPLETED", message: "The task is already complete." });
  }
  if (summary.length < 8 || /^(?:done|completed|task complete)$/i.test(summary)) {
    failures.push({
      code: "INVALID_COMPLETION_SUMMARY",
      message: "Completion summary must briefly describe the user-visible outcome.",
    });
  }
  if (state.workState.userInputNeeded?.trim() || state.workState.status === "needs_user_input") {
    failures.push({ code: "USER_INPUT_REQUIRED", message: "The task still requires user input." });
  }
  if ((state.workState.blockers ?? []).some((item) => item.trim().length > 0)) {
    failures.push({ code: "ACTIVE_BLOCKERS_REMAIN", message: "The task still has active blockers." });
  }
  if (!hasCompletionEvidence(state)) {
    failures.push({
      code: "COMPLETION_EVIDENCE_MISSING",
      message: "No successful verified task evidence is available for completion.",
    });
  }
  if (hasUnresolvedLatestFailure(state)) {
    failures.push({
      code: "UNRESOLVED_TOOL_FAILURE",
      message: "The latest task step failed and no later successful step repaired it.",
    });
  }

  const verifiedAssets = await verifyAssets(state, request.assets, failures);
  if (failures.length > 0) {
    return {
      accepted: false,
      code: "TASK_COMPLETION_REJECTED",
      failures,
      nextWorkState: rejectedWorkState(state.workState, failures),
    };
  }

  return {
    accepted: true,
    code: "TASK_COMPLETION_ACCEPTED",
    summary,
    assets: verifiedAssets,
    nextWorkState: {
      ...state.workState,
      status: "done",
      summary,
      openWork: [],
      blockers: [],
      nextStep: undefined,
      userInputNeeded: undefined,
      artifacts: uniqueStrings([
        ...(state.workState.artifacts ?? []),
        ...verifiedAssets.map((asset) => asset.resolvedPath),
      ]).slice(0, 20),
    },
  };
}

async function verifyAssets(
  state: LoopState,
  assets: TaskCompletionAssetInput[],
  failures: TaskCompletionFailure[],
): Promise<VerifiedCompletionAsset[]> {
  const verified: VerifiedCompletionAsset[] = [];
  const seen = new Set<string>();
  const root = getWorkspaceRoot();

  for (const asset of assets) {
    const normalizedInput = normalize(asset.path);
    const resolvedPath = resolveWorkspacePath(asset.path);
    const escapesWorkspace = normalizedInput === ".." || normalizedInput.startsWith(`..${sep}`);
    if (escapesWorkspace || (isAbsolute(asset.path) && !isWithinWorkspace(resolvedPath, root)) || !isWithinWorkspace(resolvedPath, root)) {
      failures.push({ code: "INVALID_ASSET_PATH", path: asset.path, message: `Completion asset is outside the workspace: ${asset.path}` });
      continue;
    }
    if (seen.has(resolvedPath)) {
      failures.push({ code: "DUPLICATE_COMPLETION_ASSET", path: asset.path, message: `Duplicate completion asset: ${asset.path}` });
      continue;
    }
    seen.add(resolvedPath);

    let info;
    try {
      info = await lstat(resolvedPath);
    } catch {
      failures.push({ code: "REQUIRED_ASSET_MISSING", path: asset.path, message: `Required completion asset does not exist: ${asset.path}` });
      continue;
    }
    const kindMatches = asset.kind === "file" ? info.isFile() : info.isDirectory();
    if (!kindMatches) {
      failures.push({ code: "ASSET_KIND_MISMATCH", path: asset.path, message: `Completion asset is not a ${asset.kind}: ${asset.path}` });
      continue;
    }
    if (!hasAssetEvidence(state, asset.path, resolvedPath)) {
      failures.push({
        code: "ASSET_MUTATION_NOT_VERIFIED",
        path: asset.path,
        message: `No verified current-run tool evidence was found for completion asset: ${asset.path}`,
      });
      continue;
    }
    verified.push({ ...asset, resolvedPath });
  }

  return verified;
}

function hasCompletionEvidence(state: LoopState): boolean {
  return state.completedSteps.some((step) => step.outcome === "success" && (step.toolSuccessCount ?? 0) > 0)
    || state.workState.verifiedFacts.length > 0
    || state.workState.evidence.length > 0
    || (state.workState.artifacts?.length ?? 0) > 0;
}

function hasUnresolvedLatestFailure(state: LoopState): boolean {
  const lastFailure = [...state.completedSteps].reverse().find((step) => step.outcome === "failed");
  if (!lastFailure) return false;
  return !state.completedSteps.some((step) => step.step > lastFailure.step && step.outcome === "success");
}

function hasAssetEvidence(state: LoopState, requestedPath: string, resolvedPath: string): boolean {
  const candidates = [requestedPath, resolvedPath].map((value) => value.replace(/\\/g, "/"));
  const containsPath = (value: unknown): boolean => {
    let text: string;
    try {
      text = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return false;
    }
    const normalized = text.replace(/\\/g, "/");
    return candidates.some((candidate) => normalized.includes(candidate));
  };
  return (state.workState.artifacts ?? []).some(containsPath)
    || state.workState.verifiedFacts.some(containsPath)
    || state.workState.evidence.some(containsPath)
    || (state.toolContext?.toolCalls ?? []).some((call) => call.status === "success"
      && (containsPath(call.input) || containsPath(call.output) || (call.artifacts ?? []).some(containsPath)));
}

function rejectedWorkState(previous: WorkState, failures: TaskCompletionFailure[]): WorkState {
  const openWork = failures.map((failure) => failure.path
    ? `${failure.message}`
    : failure.message);
  const blocked = failures.some((failure) => failure.code === "ACTIVE_BLOCKERS_REMAIN");
  const needsUserInput = failures.some((failure) => failure.code === "USER_INPUT_REQUIRED");
  return {
    ...previous,
    status: blocked ? "blocked" : needsUserInput ? "needs_user_input" : "not_done",
    summary: `Task completion verification failed: ${failures.map((failure) => failure.message).join(" ")}`,
    openWork: uniqueStrings([...(previous.openWork ?? []), ...openWork]).slice(0, 8),
    blockers: blocked ? previous.blockers : [],
    nextStep: openWork[0] ?? "Continue the task from the latest verified state.",
    userInputNeeded: needsUserInput ? previous.userInputNeeded : undefined,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
