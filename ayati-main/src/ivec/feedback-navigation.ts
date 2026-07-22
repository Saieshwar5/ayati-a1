export type FeedbackVirtualMode =
  | "ENTRY"
  | "observe.locate"
  | "observe.investigate"
  | "execute";

export type FeedbackBindingStatus =
  | "not_started"
  | "started"
  | "resolved"
  | "needs_user_input"
  | "failed";

export interface AgentFeedbackNavigationSummary {
  currentMode: FeedbackVirtualMode;
  modeRevision: number;
  transitionRequests: number;
  transitionAccepted: number;
  transitionRejected: number;
  bindingAttempts: number;
  bindingStatus: FeedbackBindingStatus;
  validationAttempts: number;
  validationAccepted: number;
  validationRejected: number;
}

export interface NavigationFeedbackEvent {
  stage: string;
  event: string;
  data?: Record<string, unknown>;
}

export function createAgentFeedbackNavigationSummary(): AgentFeedbackNavigationSummary {
  return {
    currentMode: "ENTRY",
    modeRevision: 0,
    transitionRequests: 0,
    transitionAccepted: 0,
    transitionRejected: 0,
    bindingAttempts: 0,
    bindingStatus: "not_started",
    validationAttempts: 0,
    validationAccepted: 0,
    validationRejected: 0,
  };
}

export function updateNavigationFeedbackSummary(
  previous: AgentFeedbackNavigationSummary | undefined,
  input: NavigationFeedbackEvent,
): AgentFeedbackNavigationSummary | undefined {
  if (input.stage !== "virtual_mode" && input.stage !== "workstream_binding") {
    return previous;
  }
  const summary = previous
    ? { ...previous }
    : createAgentFeedbackNavigationSummary();

  if (input.stage === "virtual_mode") {
    if (input.event === "transition_requested") {
      summary.transitionRequests++;
    } else if (input.event === "transition_applied" || input.event === "transition_resolved") {
      summary.transitionAccepted++;
    } else if (input.event.startsWith("transition_")) {
      summary.transitionRejected++;
    } else if (input.event === "validation_accepted") {
      summary.validationAttempts++;
      summary.validationAccepted++;
    } else if (input.event === "validation_rejected") {
      summary.validationAttempts++;
      summary.validationRejected++;
    }
    applyModeSnapshot(summary, input.data?.["mode"]);
    return summary;
  }

  if (input.event === "deterministic_binding_started") {
    summary.bindingAttempts++;
    summary.bindingStatus = "started";
  } else if (input.event === "deterministic_binding_resolved") {
    summary.bindingStatus = "resolved";
  } else if (input.event === "deterministic_binding_needs_user_input") {
    summary.bindingStatus = "needs_user_input";
  } else if (input.event === "deterministic_binding_failed") {
    summary.bindingStatus = "failed";
  }
  return summary;
}

export function readNavigationFeedbackSummary(
  value: unknown,
): AgentFeedbackNavigationSummary | undefined {
  const record = readRecord(value);
  if (!record) return undefined;
  const currentMode = readMode(record["currentMode"]);
  const bindingStatus = readBindingStatus(record["bindingStatus"]);
  if (!currentMode || !bindingStatus) return undefined;
  return {
    currentMode,
    modeRevision: readCount(record["modeRevision"]),
    transitionRequests: readCount(record["transitionRequests"]),
    transitionAccepted: readCount(record["transitionAccepted"]),
    transitionRejected: readCount(record["transitionRejected"]),
    bindingAttempts: readCount(record["bindingAttempts"]),
    bindingStatus,
    validationAttempts: readCount(record["validationAttempts"]),
    validationAccepted: readCount(record["validationAccepted"]),
    validationRejected: readCount(record["validationRejected"]),
  };
}

export function mergeNavigationFeedbackSummary(
  base: AgentFeedbackNavigationSummary | undefined,
  latest: AgentFeedbackNavigationSummary | undefined,
): AgentFeedbackNavigationSummary | undefined {
  if (!base) return latest ? { ...latest } : undefined;
  if (!latest) return { ...base };
  return {
    currentMode: latest.modeRevision >= base.modeRevision ? latest.currentMode : base.currentMode,
    modeRevision: Math.max(base.modeRevision, latest.modeRevision),
    transitionRequests: Math.max(base.transitionRequests, latest.transitionRequests),
    transitionAccepted: Math.max(base.transitionAccepted, latest.transitionAccepted),
    transitionRejected: Math.max(base.transitionRejected, latest.transitionRejected),
    bindingAttempts: Math.max(base.bindingAttempts, latest.bindingAttempts),
    bindingStatus: mergeBindingStatus(base.bindingStatus, latest.bindingStatus),
    validationAttempts: Math.max(base.validationAttempts, latest.validationAttempts),
    validationAccepted: Math.max(base.validationAccepted, latest.validationAccepted),
    validationRejected: Math.max(base.validationRejected, latest.validationRejected),
  };
}

function mergeBindingStatus(
  base: FeedbackBindingStatus,
  latest: FeedbackBindingStatus,
): FeedbackBindingStatus {
  if (latest === "not_started") return base;
  if (latest === "started" && isTerminalBindingStatus(base)) return base;
  return latest;
}

function isTerminalBindingStatus(status: FeedbackBindingStatus): boolean {
  return status === "resolved"
    || status === "needs_user_input"
    || status === "failed";
}

function applyModeSnapshot(
  summary: AgentFeedbackNavigationSummary,
  value: unknown,
): void {
  const record = readRecord(value);
  if (!record) return;
  const active = readMode(record["active"] ?? "ENTRY");
  if (active) summary.currentMode = active;
  const revision = readOptionalCount(record["revision"]);
  if (revision !== undefined) summary.modeRevision = Math.max(summary.modeRevision, revision);
}

function readMode(value: unknown): FeedbackVirtualMode | undefined {
  return value === "ENTRY"
    || value === "observe.locate"
    || value === "observe.investigate"
    || value === "execute"
    ? value
    : value === null ? "ENTRY" : undefined;
}

function readBindingStatus(value: unknown): FeedbackBindingStatus | undefined {
  return value === "not_started"
    || value === "started"
    || value === "resolved"
    || value === "needs_user_input"
    || value === "failed"
    ? value
    : undefined;
}

function readCount(value: unknown): number {
  return readOptionalCount(value) ?? 0;
}

function readOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
