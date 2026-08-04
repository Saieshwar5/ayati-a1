import type { WorkstreamRequestRoute } from "ayati-context-engine";
import type { ContextEngineMachineContext } from "../context-engine/index.js";

type WorkstreamRequestDecision = "initial" | WorkstreamRequestRoute["kind"];

interface WorkstreamLifecycle {
  repository?: {
    workstreamId?: string;
    contextRepositoryPath?: string;
    branch?: string;
    selectionMode?: "created" | "activated";
    workstreamCreated?: boolean;
    health?: "ready" | "dirty_external" | "unavailable";
    headBefore?: string;
    headAfter?: string;
  };
  request?: {
    decision?: WorkstreamRequestDecision;
    requestId?: string;
    status?: "queued" | "active" | "blocked" | "done" | "dropped";
    created?: boolean;
  };
  run?: {
    runId?: string;
    workstreamBound?: boolean;
  };
  finalization?: {
    status?: "not_started" | "started" | "not_required" | "no_change" | "committed" | "failed";
    outcome?: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
    validation?: "passed" | "failed" | "not_applicable";
    commit?: string;
    commitCreated?: boolean;
    headBefore?: string;
    headAfter?: string;
  };
}

type RouteSource = "model_navigation" | "deterministic_gate" | "runtime" | "unknown";
type FinalizationStatus = "not_started" | "started" | "not_required" | "no_change" | "committed" | "failed";

interface ContextEngineEventSummary {
  pendingTurnStatus?: string;
  pendingTurnRange?: { fromSeq: number; toSeq: number };
  routeStatus?: string;
  routeMode?: string;
  routeSource?: RouteSource;
  finalizationStatus?: FinalizationStatus;
  activeWorkstreamId?: string;
  workstreamId?: string;
  branch?: string;
  ref?: string;
  runId?: string;
  committed?: boolean;
  commit?: string;
  resourceCount?: number;
  workstreamBound?: boolean;
  runOutcome?: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  stopReason?: "completed" | "run_limit" | "context_limit" | "failed" | "blocked" | "needs_user_input" | "interrupted";
  commitStatus?: "not_required" | "no_change" | "committed";
  headBefore?: string;
  headAfter?: string;
  workstreamLifecycle?: WorkstreamLifecycle;
  warningCodes?: string[];
}

export function buildContextEngineEventSummary(input: {
  context?: ContextEngineMachineContext;
  pendingTurnStatus?: string;
  routeStatus?: string;
  routeMode?: string;
  routeSource?: RouteSource;
  finalizationStatus?: FinalizationStatus;
  workstreamId?: string;
  branch?: string;
  ref?: string;
  runId?: string;
  workstreamBound?: boolean;
  runOutcome?: ContextEngineEventSummary["runOutcome"];
  stopReason?: ContextEngineEventSummary["stopReason"];
  commitStatus?: ContextEngineEventSummary["commitStatus"];
  headBefore?: string;
  headAfter?: string;
  committed?: boolean;
  commit?: string;
  warningCodes?: string[];
  workstreamLifecycle?: WorkstreamLifecycle;
}): ContextEngineEventSummary | undefined {
  const context = input.context;
  const current = context?.current;
  const routing = current?.routing;
  const workstream = context?.workstream;
  const focus = context?.focus;
  const activeWorkstreamId = focus?.status === "active" ? focus.workstreamId : undefined;
  const activeRef = focus?.status === "active" ? focus.ref : undefined;
  const ref = input.ref ?? workstream?.ref ?? activeRef;
  const branch = input.branch ?? routing?.branch ?? branchFromRef(ref);
  const workstreamId = input.workstreamId
    ?? routing?.workstreamId
    ?? workstream?.workstreamId
    ?? activeWorkstreamId;
  const runId = input.runId ?? current?.runId;
  const candidate = context?.workstreamCandidates?.find((item) => item.workstreamId === workstreamId);
  const contextLifecycle = workstreamId ? compactLifecycle({
    repository: {
      workstreamId,
      branch,
      health: candidate?.repositoryHealth,
      headBefore: candidate?.head,
    },
    request: candidate?.currentRequest ? {
      requestId: candidate.currentRequest.id,
      status: candidate.currentRequest.status,
    } : undefined,
    run: runId ? {
      runId,
      workstreamBound: Boolean(workstreamId),
    } : undefined,
  }) : undefined;
  const workstreamLifecycle = mergeLifecycle(contextLifecycle, input.workstreamLifecycle);

  return compactSummary({
    ...(input.pendingTurnStatus ?? routing?.status ? { pendingTurnStatus: input.pendingTurnStatus ?? routing?.status } : {}),
    ...(current?.inputSeq !== undefined ? {
      pendingTurnRange: { fromSeq: current.inputSeq, toSeq: current.inputSeq },
    } : {}),
    ...(input.routeStatus ? { routeStatus: input.routeStatus } : {}),
    ...(input.routeMode ? { routeMode: input.routeMode } : {}),
    ...(input.routeSource ? { routeSource: input.routeSource } : {}),
    ...(input.finalizationStatus ? { finalizationStatus: input.finalizationStatus } : {}),
    ...(activeWorkstreamId ? { activeWorkstreamId } : {}),
    ...(workstreamId ? { workstreamId } : {}),
    ...(branch ? { branch } : {}),
    ...(ref ? { ref } : {}),
    ...(runId ? { runId } : {}),
    ...(input.workstreamBound !== undefined ? { workstreamBound: input.workstreamBound } : {}),
    ...(input.runOutcome ? { runOutcome: input.runOutcome } : {}),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.commitStatus ? { commitStatus: input.commitStatus } : {}),
    ...(input.headBefore ? { headBefore: input.headBefore } : {}),
    ...(input.headAfter ? { headAfter: input.headAfter } : {}),
    ...(input.committed !== undefined ? { committed: input.committed } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(workstream ? { resourceCount: workstream.resources.length } : {}),
    ...(input.warningCodes?.length ? { warningCodes: unique(input.warningCodes) } : {}),
    ...(workstreamLifecycle ? { workstreamLifecycle } : {}),
  });
}

function mergeLifecycle(
  current: WorkstreamLifecycle | undefined,
  update: WorkstreamLifecycle | undefined,
): WorkstreamLifecycle | undefined {
  if (!current) return compactLifecycle(update);
  if (!update) return compactLifecycle(current);
  return compactLifecycle({
    repository: mergeDefined(current.repository, update.repository),
    request: mergeDefined(current.request, update.request),
    run: mergeDefined(current.run, update.run),
    finalization: mergeDefined(current.finalization, update.finalization),
  });
}

function compactLifecycle(value: WorkstreamLifecycle | undefined): WorkstreamLifecycle | undefined {
  if (!value) return undefined;
  const compacted: WorkstreamLifecycle = {
    ...(hasValues(value.repository) ? { repository: value.repository } : {}),
    ...(hasValues(value.request) ? { request: value.request } : {}),
    ...(hasValues(value.run) ? { run: value.run } : {}),
    ...(hasValues(value.finalization) ? { finalization: value.finalization } : {}),
  };
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}

function compactSummary(value: ContextEngineEventSummary): ContextEngineEventSummary | undefined {
  const output = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as ContextEngineEventSummary;
  return Object.keys(output).length > 0 ? output : undefined;
}

function mergeDefined<T extends object>(current: T | undefined, update: T | undefined): T | undefined {
  if (!current) return update;
  if (!update) return current;
  return {
    ...current,
    ...Object.fromEntries(Object.entries(update).filter(([, entry]) => entry !== undefined)),
  };
}

function hasValues(value: object | undefined): boolean {
  return Boolean(value && Object.values(value).some((entry) => entry !== undefined));
}

function branchFromRef(ref: string | undefined): string | undefined {
  const match = /^refs\/heads\/(.+)$/.exec(ref ?? "");
  return match?.[1];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
