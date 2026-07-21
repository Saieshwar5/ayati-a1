import { lstat } from "node:fs/promises";
import { isAbsolute, posix, resolve } from "node:path";
import { canonicalizeAbsolutePath, isWithinWorkspace } from "../../skills/workspace-paths.js";
import type { LoopState, WorkState } from "../types.js";
import type {
  AgentWorkstreamCompletionRequest,
  WorkstreamCompletionResourceInput,
} from "./decision.js";

export type WorkstreamCompletionFailureCode =
  | "NO_WORKSTREAM_BINDING"
  | "WORKSTREAM_ALREADY_COMPLETED"
  | "COMPLETION_EVIDENCE_MISSING"
  | "OPEN_WORK_REMAINS"
  | "ACTIVE_BLOCKERS_REMAIN"
  | "USER_INPUT_REQUIRED"
  | "INVALID_COMPLETION_SUMMARY"
  | "RESOURCE_NOT_BOUND"
  | "RESOURCE_NOT_FILESYSTEM"
  | "DUPLICATE_COMPLETION_RESOURCE"
  | "INVALID_RESOURCE_PATH"
  | "REQUIRED_RESOURCE_MISSING"
  | "RESOURCE_KIND_MISMATCH"
  | "RESOURCE_MUTATION_NOT_VERIFIED"
  | "UNRESOLVED_TOOL_FAILURE";

export interface WorkstreamCompletionFailure {
  code: WorkstreamCompletionFailureCode;
  message: string;
  path?: string;
}

export interface VerifiedCompletionResource extends WorkstreamCompletionResourceInput {
  resolvedPath: string;
}

export type WorkstreamCompletionEvaluation =
  | {
      accepted: true;
      code: "WORKSTREAM_COMPLETION_ACCEPTED";
      summary: string;
      resources: VerifiedCompletionResource[];
      nextWorkState: WorkState;
    }
  | {
      accepted: false;
      code: "WORKSTREAM_COMPLETION_REJECTED";
      failures: WorkstreamCompletionFailure[];
      nextWorkState: WorkState;
    };

export function isWorkstreamCompletionAvailable(state: LoopState): boolean {
  return isWorkstreamBound(state)
    && Boolean(state.runId)
    && state.workState.status === "not_done";
}

export async function evaluateWorkstreamCompletion(
  state: LoopState,
  request: AgentWorkstreamCompletionRequest,
): Promise<WorkstreamCompletionEvaluation> {
  const failures: WorkstreamCompletionFailure[] = [];
  const summary = request.summary.replace(/\s+/g, " ").trim();

  if (!isWorkstreamBound(state) || !state.runId) {
    failures.push({
      code: "NO_WORKSTREAM_BINDING",
      message: "Workstream completion requires the current run to be bound to one workstream request.",
    });
  }
  if (state.workState.status === "done") {
    failures.push({ code: "WORKSTREAM_ALREADY_COMPLETED", message: "The workstream request is already complete." });
  }
  if (summary.length < 8 || /^(?:done|completed|workstream complete)$/i.test(summary)) {
    failures.push({
      code: "INVALID_COMPLETION_SUMMARY",
      message: "Completion summary must briefly describe the user-visible outcome.",
    });
  }
  if (state.workState.userInputNeeded?.trim() || state.workState.status === "needs_user_input") {
    failures.push({ code: "USER_INPUT_REQUIRED", message: "The workstream request still requires user input." });
  }
  if ((state.workState.blockers ?? []).some((item) => item.trim().length > 0)) {
    failures.push({ code: "ACTIVE_BLOCKERS_REMAIN", message: "The workstream request still has active blockers." });
  }
  if ((state.workState.openWork ?? []).some((item) => item.trim().length > 0)) {
    failures.push({ code: "OPEN_WORK_REMAINS", message: "The workstream request still has unfinished work." });
  }
  if (!hasCompletionEvidence(state)) {
    failures.push({
      code: "COMPLETION_EVIDENCE_MISSING",
      message: "No successful verified workstream evidence is available for completion.",
    });
  }
  if (hasUnresolvedLatestFailure(state)) {
    failures.push({
      code: "UNRESOLVED_TOOL_FAILURE",
      message: "The latest workstream step failed and no later successful step repaired it.",
    });
  }

  const verifiedResources = await verifyResources(state, request.resources, failures);
  if (failures.length > 0) {
    return {
      accepted: false,
      code: "WORKSTREAM_COMPLETION_REJECTED",
      failures,
      nextWorkState: rejectedWorkState(state.workState, failures),
    };
  }

  return {
    accepted: true,
    code: "WORKSTREAM_COMPLETION_ACCEPTED",
    summary,
    resources: verifiedResources,
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
        ...verifiedResources.map((resource) => resource.resolvedPath),
      ]).slice(0, 20),
    },
  };
}

function isWorkstreamBound(state: LoopState): boolean {
  return state.harnessContext.contextEngine?.current.routing?.status === "bound";
}

async function verifyResources(
  state: LoopState,
  resources: WorkstreamCompletionResourceInput[],
  failures: WorkstreamCompletionFailure[],
): Promise<VerifiedCompletionResource[]> {
  const verified: VerifiedCompletionResource[] = [];
  const seen = new Set<string>();
  const bindings = state.harnessContext.contextEngine?.workstream?.resources ?? [];

  for (const resource of resources) {
    const binding = bindings.find((candidate) => candidate.resource.resourceId === resource.resourceId);
    if (!binding) {
      failures.push({
        code: "RESOURCE_NOT_BOUND",
        path: resource.path,
        message: `Completion resource is not bound to this workstream: ${resource.resourceId}`,
      });
      continue;
    }
    if (binding.resource.locator.kind !== "filesystem") {
      failures.push({
        code: "RESOURCE_NOT_FILESYSTEM",
        path: resource.path,
        message: `Completion path requires a filesystem resource: ${resource.resourceId}`,
      });
      continue;
    }
    const portablePath = normalizePortableCompletionPath(resource.path);
    if (!portablePath) {
      failures.push({
        code: "INVALID_RESOURCE_PATH",
        path: resource.path,
        message: `Completion output must use a portable path relative to resource ${resource.resourceId}: ${resource.path}`,
      });
      continue;
    }
    const canonicalRoot = await canonicalizeAbsolutePath(binding.resource.locator.path);
    const resolvedPath = await canonicalizeAbsolutePath(resolve(canonicalRoot, portablePath));
    if (!isWithinWorkspace(resolvedPath, canonicalRoot)) {
      failures.push({
        code: "INVALID_RESOURCE_PATH",
        path: resource.path,
        message: `Completion output is outside bound resource ${resource.resourceId}: ${resource.path}`,
      });
      continue;
    }
    const identity = `${resource.resourceId}\0${resolvedPath}`;
    if (seen.has(identity)) {
      failures.push({
        code: "DUPLICATE_COMPLETION_RESOURCE",
        path: resource.path,
        message: `Duplicate completion resource: ${resource.resourceId}:${resource.path}`,
      });
      continue;
    }
    seen.add(identity);

    let info;
    try {
      info = await lstat(resolvedPath);
    } catch {
      failures.push({
        code: "REQUIRED_RESOURCE_MISSING",
        path: resource.path,
        message: `Required completion output does not exist: ${resource.resourceId}:${resource.path}`,
      });
      continue;
    }
    const kindMatches = resource.kind === "file" ? info.isFile() : info.isDirectory();
    if (!kindMatches) {
      failures.push({
        code: "RESOURCE_KIND_MISMATCH",
        path: resource.path,
        message: `Completion output is not a ${resource.kind}: ${resource.resourceId}:${resource.path}`,
      });
      continue;
    }
    if (!hasResourceEvidence(state, resource.resourceId, resolvedPath)) {
      failures.push({
        code: "RESOURCE_MUTATION_NOT_VERIFIED",
        path: resource.path,
        message: `No verified current-run evidence was found for completion output: ${resource.resourceId}:${resource.path}`,
      });
      continue;
    }
    verified.push({ ...resource, path: portablePath, resolvedPath });
  }

  return verified;
}

function normalizePortableCompletionPath(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  const normalized = posix.normalize(trimmed);
  const rawSegments = trimmed.split("/");
  const segments = normalized.split("/");
  if (!trimmed
    || isAbsolute(trimmed)
    || trimmed.startsWith("/")
    || /^[A-Za-z]:\//.test(trimmed)
    || /[\u0000-\u001f\u007f]/.test(trimmed)
    || normalized === ".."
    || normalized.startsWith("../")
    || rawSegments.includes("..")
    || segments.includes("..")
    || segments.includes(".git")
    || segments[0] === ".ayati") {
    return null;
  }
  return normalized === "." ? "." : normalized.replace(/^\.\//, "");
}

function hasCompletionEvidence(state: LoopState): boolean {
  return state.completedSteps.some((step) =>
    step.outcome === "success"
    && step.validationStatus !== "failed"
    && step.expectationCheckStatus !== "failed"
    && (step.toolSuccessCount ?? 0) > 0
    && (step.toolsUsed ?? []).some(isTaskExecutionTool));
}

function hasUnresolvedLatestFailure(state: LoopState): boolean {
  const lastFailure = [...state.completedSteps].reverse().find((step) => step.outcome === "failed");
  if (!lastFailure) return false;
  return !state.completedSteps.some((step) => step.step > lastFailure.step && step.outcome === "success");
}

function hasResourceEvidence(state: LoopState, resourceId: string, resolvedPath: string): boolean {
  const candidate = resolvedPath.replace(/\\/g, "/");
  const samePath = (value: string | undefined): boolean =>
    typeof value === "string" && value.replace(/\\/g, "/") === candidate;
  return (state.workState.artifacts ?? []).some(samePath)
    || (state.toolContext?.toolCalls ?? []).some((call) => call.status === "success"
      && (call.artifacts ?? []).some((artifact) =>
        samePath(artifact.path)
        || samePath(artifact.uri)
        || (artifact.id === resourceId && samePath(artifact.metadata?.["path"] as string | undefined))));
}

function isTaskExecutionTool(tool: string): boolean {
  return tool !== "workstream_resolve"
    && tool !== "workstream_completion"
    && tool !== "decision_load_tools"
    && tool !== "ask_user_feedback"
    && !tool.startsWith("git_context_");
}

function rejectedWorkState(previous: WorkState, failures: WorkstreamCompletionFailure[]): WorkState {
  const openWork = failures.map((failure) => failure.path
    ? `${failure.message}`
    : failure.message);
  const blocked = failures.some((failure) => failure.code === "ACTIVE_BLOCKERS_REMAIN");
  const needsUserInput = failures.some((failure) => failure.code === "USER_INPUT_REQUIRED");
  return {
    ...previous,
    status: blocked ? "blocked" : needsUserInput ? "needs_user_input" : "not_done",
    summary: `Workstream completion verification failed: ${failures.map((failure) => failure.message).join(" ")}`,
    openWork: uniqueStrings([...(previous.openWork ?? []), ...openWork]).slice(0, 8),
    blockers: blocked ? previous.blockers : [],
    nextStep: openWork[0] ?? "Continue the workstream request from the latest verified state.",
    userInputNeeded: needsUserInput ? previous.userInputNeeded : undefined,
  };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
