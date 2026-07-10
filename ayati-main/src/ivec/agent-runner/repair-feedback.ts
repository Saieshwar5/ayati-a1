import type { SessionInputHandle } from "../../memory/types.js";
import type {
  AgentLoopDeps,
  LoopConfig,
  LoopState,
  StepSummary,
} from "../types.js";
import { buildContextEngineFeedbackSummary } from "../feedback-ledger.js";
import type { AgentDecision } from "./decision.js";
import type { ReadProgressViolation } from "./read-progress-policy.js";
import { markReadProgressRejected } from "./read-progress-policy.js";
import type { RepairCode, RepairSignal } from "./repair-policy.js";
import {
  createRepairSignal,
  repairSignalToFeedbackData,
  repairSignalToPromptCard,
} from "./repair-policy.js";
import { deferredMutationToolNames } from "./task-routing-policy.js";
import {
  summarizeDecision,
  summarizeHarnessContext,
  summarizeStep,
} from "./feedback-summary.js";

const FRESH_SESSION_TOOL_REPAIR_MESSAGE = "No active task exists. Before mutation, search and activate an existing task or create a new task. Ask a short clarification directly if task ownership is unclear.";
const REPEATED_REPAIR_FAILURE_THRESHOLD = 3;

export function recordFreshSessionToolRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: AgentDecision;
  reason: "fresh_session_tool_load" | "fresh_session_wrong_tool";
}): void {
  input.state.consecutiveFailures++;
  const blockedTargets = freshSessionDecisionTargets(input.decision);
  const repair = createRepairSignal("R_FRESH_SESSION_NEEDS_TASK", {
    blockedTargets,
    operatorDetails: {
      reason: input.reason,
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      contextEngine: buildContextEngineFeedbackSummary({
        context: input.state.harnessContext.contextEngine,
      }),
      harnessContext: summarizeHarnessContext(input.state.harnessContext),
    },
  });
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "validation_error",
    reason: FRESH_SESSION_TOOL_REPAIR_MESSAGE,
    blockedTargets,
    repairCode: repair.code,
    repair: repairSignalToPromptCard(repair),
  });
  recordFeedback(input.deps, input.inputHandle, undefined, "guard", "fresh_session_tool_repair_requested", {
    reason: input.reason,
    message: FRESH_SESSION_TOOL_REPAIR_MESSAGE,
    warningCodes: ["fresh_session_tool_repair_requested"],
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    blockedTargets,
    decision: summarizeDecision(input.decision),
    contextEngine: buildContextEngineFeedbackSummary({
      context: input.state.harnessContext.contextEngine,
    }),
    harnessContext: summarizeHarnessContext(input.state.harnessContext),
    ...repairSignalToFeedbackData(repair),
  });
}

export function recordDeferredMutationRoutingRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: AgentDecision;
  reason: "deferred_mutation_reply" | "deferred_mutation_already_pending";
}): void {
  input.state.consecutiveFailures++;
  const deferredTools = input.state.deferredMutation?.blockedTools ?? [];
  const repair = createRepairSignal("R_PENDING_TURN_UNBOUND", {
    source: "runner.deferred_mutation_guard",
    message: "A mutation is already deferred and cannot execute until this session run is routed to a task.",
    blockedTargets: input.decision.kind === "act"
      ? deferredMutationToolNames(input.decision.action)
      : ["direct_reply"],
    allowedNextActions: [
      "Call git_context_activate_task_for_turn if this belongs to the active or another existing task.",
      "Call git_context_search_tasks first if another existing task may own the request.",
      "Call git_context_create_task_for_turn if this is a new durable task.",
      "After routing succeeds, the deferred mutation will execute automatically; do not repeat the mutation call.",
    ],
    operatorDetails: {
      reason: input.reason,
      deferredTools,
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      contextEngine: buildContextEngineFeedbackSummary({
        context: input.state.harnessContext.contextEngine,
      }),
    },
  });
  const promptCard = repairSignalToPromptCard(repair);
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "validation_error",
    reason: repair.message,
    blockedTargets: repair.blockedTargets,
    repairCode: repair.code,
    ...(promptCard ? { repair: promptCard } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.state.runId || undefined, "guard", "deferred_mutation_routing_required", {
    reason: input.reason,
    deferredTools,
    decision: summarizeDecision(input.decision),
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    ...repairSignalToFeedbackData(repair),
  });
}

export function recordReadProgressRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: AgentDecision;
  runId: string;
  violation: ReadProgressViolation;
}): void {
  input.state.consecutiveFailures++;
  input.state.readProgress = markReadProgressRejected(input.state.readProgress);
  const repair = createRepairSignal(input.violation.code, {
    message: input.violation.message,
    blockedTargets: input.violation.blockedTargets,
    allowedNextActions: input.violation.allowedNextActions,
    operatorDetails: {
      ...input.violation.operatorDetails,
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      readProgress: input.state.readProgress,
    },
  });
  const promptCard = repairSignalToPromptCard(repair);
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "no_progress",
    reason: repair.message,
    blockedTargets: repair.blockedTargets,
    repairCode: repair.code,
    ...(promptCard ? { repair: promptCard } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "guard", "read_progress_repair_requested", {
    message: repair.message,
    warningCodes: ["read_progress_repair_requested", repair.code],
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    decision: summarizeDecision(input.decision),
    readProgress: input.state.readProgress,
    ...repairSignalToFeedbackData(repair),
  });
}

export function recordTerminalReplyMutationRepair(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  config: LoopConfig;
  decision: Extract<AgentDecision, { kind: "reply" }>;
  reason: string;
  failedStep?: StepSummary;
}): void {
  input.state.consecutiveFailures++;
  const repair = createRepairSignal("R_MUTATION_EXPECTED_AFTER_CONTEXT", {
    source: "runner.completion_guard",
    message: input.reason,
    blockedTargets: ["direct_reply"],
    allowedNextActions: [
      "Call patch_files with small stable targets from the latest read output.",
      "Call write_files if replacing the complete file is clearer.",
      "Call another selected mutation tool if it is the correct way to complete the requested change.",
      "Do not send a final reply until a mutation tool succeeds after the latest failed mutation.",
    ],
    operatorDetails: {
      consecutiveFailures: input.state.consecutiveFailures,
      maxConsecutiveFailures: input.config.maxConsecutiveFailures,
      decision: summarizeDecision(input.decision),
      ...(input.failedStep ? { failedStep: summarizeStep(input.failedStep) } : {}),
    },
  });
  const promptCard = repairSignalToPromptCard(repair);
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "no_progress",
    reason: repair.message,
    blockedTargets: repair.blockedTargets,
    repairCode: repair.code,
    ...(promptCard ? { repair: promptCard } : {}),
  });
  recordFeedback(input.deps, input.inputHandle, input.state.runId, "guard", "terminal_reply_repair_requested", {
    message: repair.message,
    warningCodes: ["terminal_reply_rejected", repair.code],
    consecutiveFailures: input.state.consecutiveFailures,
    maxConsecutiveFailures: input.config.maxConsecutiveFailures,
    decision: summarizeDecision(input.decision),
    ...(input.failedStep ? { failedStep: summarizeStep(input.failedStep) } : {}),
    ...repairSignalToFeedbackData(repair),
  });
}

export function createMissingWorkRunRepairSignal(input: {
  reason: string;
  message: string;
  decision?: AgentDecision;
  pendingTurnStatus?: string;
}): RepairSignal {
  return createRepairSignal(missingWorkRunRepairCode(input.pendingTurnStatus), {
    blockedTargets: input.decision ? freshSessionDecisionTargets(input.decision) : [],
    operatorDetails: {
      reason: input.reason,
      message: input.message,
      pendingTurnStatus: input.pendingTurnStatus,
      ...(input.decision ? { decision: summarizeDecision(input.decision) } : {}),
    },
  });
}

export function createFailureRecordFromStepSummary(
  step: StepSummary,
  history: LoopState["failureHistory"] = [],
): LoopState["failureHistory"][number] {
  const failureType = step.failureType ?? "verify_failed";
  const reason = buildFailureHistoryReason(step);
  const blockedTargets = uniqueStrings([
    ...(step.blockedTargets ?? []),
    ...(step.blockedTargets && step.blockedTargets.length > 0 ? [] : toolsFromExecutionContract(step.executionContract)),
  ]);
  const baseRepair = createRepairSignalFromStepSummary(step);
  const repair = maybeEscalateEditRecovery(baseRepair, history);
  const promptCard = repair ? repairSignalToPromptCard(repair) : undefined;
  const repairBlockedTargets = repair ? repair.blockedTargets : blockedTargets;
  return {
    step: step.step,
    executionContract: step.executionContract,
    failureType,
    reason,
    blockedTargets: repairBlockedTargets,
    ...(repair ? { repairCode: repair.code } : {}),
    ...(promptCard ? { repair: promptCard } : {}),
  };
}

function maybeEscalateEditRecovery(
  repair: RepairSignal | undefined,
  history: LoopState["failureHistory"],
): RepairSignal | undefined {
  if (!repair || repair.code !== "R_EDIT_TARGET_RECOVERY") {
    return repair;
  }
  const current = editRecoverySignature(repair.blockedTargets);
  if (!current) {
    return repair;
  }
  const repeated = history
    .slice()
    .reverse()
    .some((failure) => (
      failure.repairCode === "R_EDIT_TARGET_RECOVERY"
      && editRecoverySignature(failure.blockedTargets)?.signature === current.signature
    ));
  if (!repeated) {
    return repair;
  }

  const filePath = current.filePath;
  return createRepairSignal("R_EDIT_ESCALATE_TO_GUARDED_REWRITE", {
    source: "runner.edit_recovery",
    message: `Precise edit/patch recovery failed repeatedly for ${filePath}. Escalate to guarded full-file rewrite.`,
    blockedTargets: repair.blockedTargets,
    allowedNextActions: [
      `Stop retrying the same patch_files target for ${filePath}.`,
      `Call read_files with files=[{path:${JSON.stringify(filePath)}, mode:"full"}] to get complete content and sha256.`,
      "Prepare the complete replacement content from that full read.",
      "Call write_files with files[].baseSha256 set to the sha256 returned by the full read.",
      "Do not use shell mutation.",
    ],
    operatorDetails: {
      previousRepairCode: repair.code,
      repeatedSignature: current.signature,
      priorFailureCount: history.filter((failure) => (
        failure.repairCode === "R_EDIT_TARGET_RECOVERY"
        && editRecoverySignature(failure.blockedTargets)?.signature === current.signature
      )).length,
    },
  });
}

function editRecoverySignature(blockedTargets: string[]): { signature: string; filePath: string } | undefined {
  const tool = blockedTargets.find((target) => target === "patch_files");
  const filePath = blockedTargets.find((target) => target !== "patch_files");
  if (!tool || !filePath) {
    return undefined;
  }
  return { signature: `${tool}:${filePath}`, filePath };
}

export function createRepairSignalFromStepSummary(step: StepSummary): RepairSignal | undefined {
  const failureType = step.failureType ?? "verify_failed";
  const reason = buildFailureHistoryReason(step);
  const blockedTargets = uniqueStrings([
    ...(step.blockedTargets ?? []),
    ...(step.blockedTargets && step.blockedTargets.length > 0 ? [] : toolsFromExecutionContract(step.executionContract)),
  ]);
  return createStepFailureRepairSignal({
    failureType,
    reason,
    blockedTargets,
    step,
  });
}

export function hasRepeatedRepairFailure(history: LoopState["failureHistory"]): boolean {
  const signature = latestRepairSignature(history);
  if (!signature) {
    return false;
  }
  let count = 0;
  for (let index = history.length - 1; index >= 0; index--) {
    const current = repairFailureSignature(history[index]);
    if (current !== signature) {
      break;
    }
    count++;
  }
  return count >= REPEATED_REPAIR_FAILURE_THRESHOLD;
}

export function hasRepeatedToolInputValidationFailure(history: LoopState["failureHistory"]): boolean {
  if (history.length < 2) {
    return false;
  }
  const latest = history[history.length - 1];
  const previous = history[history.length - 2];
  if (!latest || !previous || latest.reason !== previous.reason) {
    return false;
  }
  return latest.reason.includes("Invalid input for")
    || latest.reason.includes("Tool input preflight failed");
}

export function recordRepeatedRepairFailure(input: {
  deps: AgentLoopDeps;
  inputHandle: SessionInputHandle;
  state: LoopState;
  runId: string | undefined;
}): void {
  const previous = input.state.failureHistory[input.state.failureHistory.length - 1];
  const repair = createRepairSignal("R_REPEATED_REPAIR_FAILURE", {
    blockedTargets: previous?.blockedTargets ?? [],
    operatorDetails: {
      repeatedSignature: latestRepairSignature(input.state.failureHistory),
      repeatedThreshold: REPEATED_REPAIR_FAILURE_THRESHOLD,
      previousRepairCode: previous?.repairCode,
      previousReason: previous?.reason,
    },
  });
  input.state.failureHistory.push({
    step: input.state.iteration,
    failureType: "validation_error",
    reason: repair.message,
    blockedTargets: previous?.blockedTargets ?? [],
    repairCode: repair.code,
  });
  recordFeedback(input.deps, input.inputHandle, input.runId, "guard", "repeated_repair_failure", {
    message: repair.message,
    repeatedThreshold: REPEATED_REPAIR_FAILURE_THRESHOLD,
    previousRepairCode: previous?.repairCode,
    previousReason: previous?.reason,
    ...repairSignalToFeedbackData(repair),
  });
}

function missingWorkRunRepairCode(pendingTurnStatus: string | undefined): "R_NORMAL_TOOL_WITHOUT_TASK_RUN" | "R_PENDING_TURN_UNBOUND" | "R_PENDING_TURN_CLARIFYING" {
  if (pendingTurnStatus === "unbound") {
    return "R_PENDING_TURN_UNBOUND";
  }
  if (pendingTurnStatus === "clarifying") {
    return "R_PENDING_TURN_CLARIFYING";
  }
  return "R_NORMAL_TOOL_WITHOUT_TASK_RUN";
}

function createStepFailureRepairSignal(input: {
  failureType: LoopState["failureHistory"][number]["failureType"];
  reason: string;
  blockedTargets: string[];
  step: StepSummary;
}): RepairSignal | undefined {
  const editRecovery = extractEditTargetRecovery(input.step);
  if (editRecovery) {
    return createRepairSignal("R_EDIT_TARGET_RECOVERY", {
      source: "runner.edit_recovery",
      message: editRecovery.message,
      blockedTargets: uniqueStrings([editRecovery.tool, editRecovery.filePath].filter((value): value is string => Boolean(value))),
      allowedNextActions: buildEditRecoveryActions(editRecovery),
      operatorDetails: {
        step: input.step.step,
        reason: input.reason,
        failureType: input.failureType,
        executionContract: input.step.executionContract,
        toolsUsed: input.step.toolsUsed,
        recovery: editRecovery,
      },
    });
  }

  const missingFields = extractMissingRequiredFields(input.reason);
  const invalidFields = missingFields.length > 0 ? [] : extractInvalidFields(input.reason);
  const code = stepFailureRepairCode(input.failureType, input.reason, missingFields, invalidFields);
  if (!code) {
    return undefined;
  }
  return createRepairSignal(code, {
    blockedTargets: input.blockedTargets,
    missingFields,
    invalidFields,
    operatorDetails: {
      step: input.step.step,
      reason: input.reason,
      failureType: input.failureType,
      executionContract: input.step.executionContract,
      toolsUsed: input.step.toolsUsed,
      evidenceItems: input.step.evidenceItems,
    },
  });
}

interface EditTargetRecovery {
  tool: string;
  code?: string;
  filePath?: string;
  patchIndex?: number;
  failedEditIndex?: number;
  kind?: string;
  mode?: string;
  diagnostic: {
    targetKind?: string;
    reason?: string;
    hint?: string;
    nearestMatchLine?: number;
    nearestMatchPreview?: string;
    matchStrategy?: string;
  };
  message: string;
}

function extractEditTargetRecovery(step: StepSummary): EditTargetRecovery | undefined {
  const calls = evidenceToolCalls(step);
  for (const call of calls) {
    const tool = readString(call, "tool");
    if (tool !== "patch_files") continue;
    const code = readString(call, "code");
    if (
      code !== "PATCH_TARGET_NOT_FOUND"
      && code !== "PATCH_TARGET_AMBIGUOUS"
    ) {
      continue;
    }
    const diagnostic = readRecord(call["diagnostic"]);
    if (!diagnostic) continue;

    const recovery: EditTargetRecovery = {
      tool,
      ...(code ? { code } : {}),
      ...(readString(call, "filePath") ? { filePath: readString(call, "filePath") } : {}),
      ...(readNumber(call, "patchIndex") !== undefined ? { patchIndex: readNumber(call, "patchIndex") } : {}),
      ...(readNumber(call, "failedEditIndex") !== undefined ? { failedEditIndex: readNumber(call, "failedEditIndex") } : {}),
      ...(readString(call, "operationKind") ? { kind: readString(call, "operationKind") } : {}),
      ...(readString(call, "mode") ? { mode: readString(call, "mode") } : {}),
      diagnostic: {
        ...(readString(diagnostic, "targetKind") ? { targetKind: readString(diagnostic, "targetKind") } : {}),
        ...(readString(diagnostic, "reason") ? { reason: readString(diagnostic, "reason") } : {}),
        ...(readString(diagnostic, "hint") ? { hint: readString(diagnostic, "hint") } : {}),
        ...(readNumber(diagnostic, "nearestMatchLine") !== undefined ? { nearestMatchLine: readNumber(diagnostic, "nearestMatchLine") } : {}),
        ...(readString(diagnostic, "nearestMatchPreview") ? { nearestMatchPreview: readString(diagnostic, "nearestMatchPreview") } : {}),
        ...(readString(diagnostic, "matchStrategy") ? { matchStrategy: readString(diagnostic, "matchStrategy") } : {}),
      },
      message: buildEditRecoveryMessage(tool, code, diagnostic),
    };
    return recovery;
  }
  return undefined;
}

function evidenceToolCalls(step: StepSummary): Record<string, unknown>[] {
  const source = readRecord(step.evidenceSource);
  const calls = source && Array.isArray(source["toolCalls"]) ? source["toolCalls"] : [];
  return calls.filter((call): call is Record<string, unknown> => Boolean(call && typeof call === "object" && !Array.isArray(call)));
}

function buildEditRecoveryMessage(tool: string, code: string | undefined, diagnostic: Record<string, unknown>): string {
  const reason = readString(diagnostic, "reason") ?? "The requested edit target was not found exactly.";
  const line = readNumber(diagnostic, "nearestMatchLine");
  const strategy = readString(diagnostic, "matchStrategy");
  return [
    `${tool} failed${code ? ` with ${code}` : ""}.`,
    reason,
    line !== undefined ? `Nearest likely context starts around line ${line}.` : "",
    strategy ? `Match strategy: ${strategy}.` : "",
  ].filter((part) => part.length > 0).join(" ");
}

function buildEditRecoveryActions(recovery: EditTargetRecovery): string[] {
  const actions: string[] = [];
  const file = recovery.filePath ?? "the failed file";
  const line = recovery.diagnostic.nearestMatchLine;
  if (line !== undefined) {
    actions.push(`Call read_files with files=[{path:${JSON.stringify(file)}, mode:"slice", startLine=${Math.max(1, line - 3)}, lineCount:8}] before retrying.`);
  } else {
    actions.push(`Read the latest exact context for ${file} before retrying.`);
  }
  if (recovery.diagnostic.matchStrategy === "whitespace_normalized") {
    actions.push("The target likely differs only by multiline formatting or indentation; retry with exact text from the slice or use replace_lines.");
  } else if (recovery.diagnostic.matchStrategy) {
    actions.push(`Use the diagnostic ${recovery.diagnostic.matchStrategy} clue to choose a smaller exact target from the current file.`);
  }
  if (recovery.diagnostic.hint) {
    actions.push(recovery.diagnostic.hint);
  }
  actions.push("Do not retry the same stale target string.");
  actions.push("Use guarded write_files only after a full read returns sha256 and repeated precise patch/edit attempts still fail.");
  return actions;
}

function stepFailureRepairCode(
  failureType: LoopState["failureHistory"][number]["failureType"],
  reason: string,
  missingFields: string[],
  invalidFields: string[],
): RepairCode | undefined {
  if (failureType === "validation_error") {
    return missingFields.length > 0 ? "R_TOOL_INPUT_MISSING_REQUIRED_FIELD" : "R_TOOL_INPUT_INVALID";
  }
  if (reason.includes("was not selected") || reason.includes("was not listed in action.allowedTools")) {
    return "R_TOOL_NOT_SELECTED";
  }
  if (failureType === "verify_failed") {
    return "R_VERIFICATION_FAILED";
  }
  if (failureType === "no_progress") {
    return "R_NO_PROGRESS";
  }
  if (reason.includes("missing required field")) {
    return "R_TOOL_INPUT_MISSING_REQUIRED_FIELD";
  }
  if (reason.includes("Invalid input for") || reason.includes("Tool input preflight failed")) {
    return invalidFields.length > 0 ? "R_TOOL_INPUT_INVALID" : "R_TOOL_INPUT_INVALID";
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toolsFromExecutionContract(value: string | undefined): string[] {
  const match = value?.match(/^(?:single|sequential|parallel) action: (.+)$/);
  const calls = match?.[1];
  if (!calls || calls === "no calls") {
    return [];
  }
  return calls
    .split(",")
    .map((call) => call.trim().split(/\s|\(/)[0])
    .filter((tool): tool is string => Boolean(tool) && tool !== "execution_plan");
}

function latestRepairSignature(history: LoopState["failureHistory"]): string | undefined {
  return repairFailureSignature(history[history.length - 1]);
}

function repairFailureSignature(failure: LoopState["failureHistory"][number] | undefined): string | undefined {
  if (!failure?.repairCode || failure.repairCode === "R_REPEATED_REPAIR_FAILURE") {
    return undefined;
  }
  const repair = failure.repair;
  return [
    failure.repairCode,
    compactSignaturePart(failure.blockedTargets),
    compactSignaturePart(repair?.missingFields ?? []),
    compactSignaturePart(repair?.invalidFields ?? []),
  ].join("|");
}

function compactSignaturePart(values: string[]): string {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))]
    .sort()
    .join(",");
}

function extractMissingRequiredFields(error: string): string[] {
  const matches = [...error.matchAll(/missing required field '([^']+)'/g)];
  return matches.map((match) => match[1]).filter((field): field is string => Boolean(field));
}

function extractInvalidFields(error: string): string[] {
  const matches = [...error.matchAll(/field '([^']+)' expected type/g)];
  return matches.map((match) => match[1]).filter((field): field is string => Boolean(field));
}

function freshSessionDecisionTargets(decision: AgentDecision): string[] {
  if (decision.kind === "load_tools") {
    return uniqueStrings([
      ...decision.request.toolNames,
      ...decision.request.groups.map((group) => `group:${group}`),
      ...(decision.request.query ? [`query:${decision.request.query}`] : []),
    ]);
  }
  if (decision.kind === "act") {
    return uniqueStrings([
      ...decision.action.calls.map((call) => call.tool),
      ...decision.action.allowedTools,
    ]);
  }
  return [];
}

function buildFailureHistoryReason(step: StepSummary): string {
  const primaryEvidence = step.evidenceItems?.find((item) => item.trim().length > 0);
  if (
    primaryEvidence
    && (
      step.summary === "Step failed during tool execution before output validation could run."
      || step.summary === "Step produced no output to validate."
    )
  ) {
    return `${step.summary}: ${primaryEvidence}`;
  }
  return step.summary;
}

function recordFeedback(
  deps: AgentLoopDeps,
  inputHandle: SessionInputHandle,
  runId: string | undefined,
  stage: string,
  event: string,
  data?: Record<string, unknown>,
): void {
  deps.feedbackLedger?.record({
    clientId: deps.clientId,
    sessionId: inputHandle.sessionId,
    seq: inputHandle.seq,
    ...(runId ? { runId } : {}),
    stage,
    event,
    ...(data ? { data } : {}),
  });
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}
