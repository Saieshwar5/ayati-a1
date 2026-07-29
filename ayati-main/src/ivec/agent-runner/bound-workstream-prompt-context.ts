import type { ContextEngineMachineContext } from "../../context-engine/index.js";
import { compactOptionalText, compactText } from "../state-compaction.js";

export const BOUND_WORKSTREAM_PROMPT_LIMITS = {
  purposeChars: 1_200,
  summaryChars: 1_200,
  currentFocusChars: 500,
  blockerCount: 8,
  blockerChars: 300,
  nextActionChars: 500,
  recentProgressCount: 5,
  progressSummaryChars: 800,
  progressValidationChars: 500,
  progressNextChars: 500,
} as const;

export interface PromptBoundWorkstreamContext {
  id: string;
  title: string;
  purpose: string;
  summary: string;
  lifecycleStatus: "active" | "paused" | "archived";
  currentFocus?: string;
  blockers: string[];
  nextAction?: string;
  request: PromptBoundRequestContext;
  /** The active request is identified only when it differs from the run-bound request. */
  activeRequest?: {
    id: string;
    title: string;
    status: "active";
  };
  recentProgress: PromptBoundWorkstreamProgress[];
}

export interface PromptBoundRequestContext {
  id: string;
  title: string;
  status: "queued" | "active" | "blocked";
  request: string;
  acceptance: string[];
  constraints: string[];
  lifecycleNote?: string;
}

export interface PromptBoundWorkstreamProgress {
  runId: string;
  outcome: "done" | "incomplete" | "failed" | "blocked" | "needs_user_input";
  summary: string;
  validation: string;
  next?: string;
}

/**
 * Builds the bounded, model-facing context for the exact request selected by
 * the current run. Binding identity is authoritative: inconsistent projections
 * fail closed instead of falling back to a workstream's old active request.
 */
export function buildBoundWorkstreamPromptContext(
  context: ContextEngineMachineContext | undefined,
): PromptBoundWorkstreamContext | undefined {
  const routing = context?.current.routing;
  if (!context || routing?.status !== "bound") {
    return undefined;
  }

  const workstreamId = requireIdentity(
    routing.workstreamId,
    "BOUND_WORKSTREAM_CONTEXT_MISSING",
    "A bound route has no workstream ID.",
  );
  const requestId = requireIdentity(
    routing.requestId,
    "BOUND_REQUEST_CONTEXT_MISSING",
    "A bound route has no request ID.",
  );
  const workstream = context.workstream;
  if (!workstream) {
    failContext(
      "BOUND_WORKSTREAM_CONTEXT_MISSING",
      `No workstream projection is loaded for ${workstreamId}.`,
    );
  }
  if (workstream.workstreamId !== workstreamId) {
    failContext(
      "BOUND_WORKSTREAM_CONTEXT_MISMATCH",
      `Loaded ${workstream.workstreamId}, but the run is bound to ${workstreamId}.`,
    );
  }

  const persistedBinding = context.run?.run.workstreamBinding;
  if (
    persistedBinding
    && (
      persistedBinding.workstreamId !== workstreamId
      || persistedBinding.requestId !== requestId
    )
  ) {
    failContext(
      "BOUND_REQUEST_CONTEXT_MISMATCH",
      `The run binding does not match ${workstreamId}/${requestId}.`,
    );
  }

  const selectedRequest = workstream.selectedRequest;
  if (!selectedRequest) {
    failContext(
      "BOUND_REQUEST_CONTEXT_MISSING",
      `No selected request projection is loaded for ${workstreamId}/${requestId}.`,
    );
  }
  if (selectedRequest.id !== requestId) {
    failContext(
      "BOUND_REQUEST_CONTEXT_MISMATCH",
      `Loaded ${selectedRequest.id}, but the run is bound to ${requestId}.`,
    );
  }
  if (selectedRequest.status === "done" || selectedRequest.status === "dropped") {
    failContext(
      "BOUND_REQUEST_CONTEXT_TERMINAL",
      `A run cannot execute terminal request ${requestId} (${selectedRequest.status}).`,
    );
  }

  const activeRequest = projectDifferentActiveRequest({
    selectedRequest,
    currentRequest: workstream.currentRequest,
  });
  if (
    workstream.lifecycleStatus !== "active"
    && (selectedRequest.status === "active" || activeRequest)
  ) {
    failContext(
      "BOUND_WORKSTREAM_CONTEXT_MISMATCH",
      `${workstream.lifecycleStatus} workstream ${workstreamId} cannot have an active request.`,
    );
  }

  const currentFocus = compactOptionalText(
    workstream.currentFocus,
    BOUND_WORKSTREAM_PROMPT_LIMITS.currentFocusChars,
  );
  const nextAction = compactOptionalText(
    workstream.next,
    BOUND_WORKSTREAM_PROMPT_LIMITS.nextActionChars,
  );

  return {
    id: workstreamId,
    title: workstream.title,
    purpose: compactText(workstream.objective, BOUND_WORKSTREAM_PROMPT_LIMITS.purposeChars),
    summary: compactText(workstream.summary, BOUND_WORKSTREAM_PROMPT_LIMITS.summaryChars),
    lifecycleStatus: workstream.lifecycleStatus,
    ...(currentFocus ? { currentFocus } : {}),
    blockers: workstream.blockers
      .map((blocker) => compactText(blocker, BOUND_WORKSTREAM_PROMPT_LIMITS.blockerChars))
      .filter((blocker) => blocker.length > 0)
      .slice(0, BOUND_WORKSTREAM_PROMPT_LIMITS.blockerCount),
    ...(nextAction ? { nextAction } : {}),
    request: {
      id: selectedRequest.id,
      title: selectedRequest.title,
      status: selectedRequest.status,
      request: selectedRequest.request,
      acceptance: [...selectedRequest.acceptance],
      constraints: [...selectedRequest.constraints],
      ...(selectedRequest.lifecycleNote
        ? { lifecycleNote: selectedRequest.lifecycleNote }
        : {}),
    },
    ...(activeRequest ? { activeRequest } : {}),
    recentProgress: [...workstream.recentProgress]
      .sort(compareNewestProgressFirst)
      .slice(0, BOUND_WORKSTREAM_PROMPT_LIMITS.recentProgressCount)
      .map((progress) => projectRecentProgress(progress)),
  };
}

function projectDifferentActiveRequest(input: {
  selectedRequest: NonNullable<
    NonNullable<ContextEngineMachineContext["workstream"]>["selectedRequest"]
  >;
  currentRequest: NonNullable<ContextEngineMachineContext["workstream"]>["currentRequest"];
}): PromptBoundWorkstreamContext["activeRequest"] {
  const { currentRequest, selectedRequest } = input;
  if (!currentRequest) {
    if (selectedRequest.status === "active") {
      failContext(
        "BOUND_REQUEST_CONTEXT_MISMATCH",
        `Selected request ${selectedRequest.id} is active, but the workstream has no active request.`,
      );
    }
    return undefined;
  }
  if (currentRequest.status !== "active") {
    failContext(
      "BOUND_REQUEST_CONTEXT_MISMATCH",
      `Current request ${currentRequest.id} is ${currentRequest.status}, not active.`,
    );
  }
  if (currentRequest.id === selectedRequest.id) {
    if (selectedRequest.status !== "active") {
      failContext(
        "BOUND_REQUEST_CONTEXT_MISMATCH",
        `Selected request ${selectedRequest.id} disagrees with its active current-request projection.`,
      );
    }
    return undefined;
  }
  if (selectedRequest.status === "active") {
    failContext(
      "BOUND_REQUEST_CONTEXT_MISMATCH",
      `Selected request ${selectedRequest.id} and current request ${currentRequest.id} are both active.`,
    );
  }
  return {
    id: currentRequest.id,
    title: currentRequest.title,
    status: "active",
  };
}

function compareNewestProgressFirst(
  left: NonNullable<ContextEngineMachineContext["workstream"]>["recentProgress"][number],
  right: NonNullable<ContextEngineMachineContext["workstream"]>["recentProgress"][number],
): number {
  const byTime = right.finalizedAt.localeCompare(left.finalizedAt);
  return byTime !== 0 ? byTime : right.runId.localeCompare(left.runId);
}

function projectRecentProgress(
  progress: NonNullable<ContextEngineMachineContext["workstream"]>["recentProgress"][number],
): PromptBoundWorkstreamProgress {
  const next = compactOptionalText(
    progress.nextAction,
    BOUND_WORKSTREAM_PROMPT_LIMITS.progressNextChars,
  );
  return {
    runId: progress.runId,
    outcome: progress.outcome,
    summary: compactText(
      progress.summary,
      BOUND_WORKSTREAM_PROMPT_LIMITS.progressSummaryChars,
    ),
    validation: compactText(
      progress.validationSummary,
      BOUND_WORKSTREAM_PROMPT_LIMITS.progressValidationChars,
    ),
    ...(next ? { next } : {}),
  };
}

function requireIdentity(
  value: string | undefined,
  code: string,
  message: string,
): string {
  if (!value) {
    failContext(code, message);
  }
  return value;
}

function failContext(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}
