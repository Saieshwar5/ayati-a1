import type {
  EvaluationEvent,
  EvaluationFinding,
  ModelOperation,
  ProviderRequest,
} from "./contracts.js";
import { canonicalHash } from "./canonical.js";

export interface HydratedEvaluationEvent {
  record: EvaluationEvent;
  data?: Record<string, unknown>;
}

export interface HydratedCanonicalRequest {
  request: ProviderRequest;
  value?: Record<string, unknown>;
}

export function buildDeterministicFindings(input: {
  runId: string;
  events: HydratedEvaluationEvent[];
  operations: ModelOperation[];
  requests: ProviderRequest[];
  canonicalRequests?: HydratedCanonicalRequest[];
  currentInput?: string;
  captureDegraded: boolean;
}): EvaluationFinding[] {
  const findings: EvaluationFinding[] = [];
  const add = (
    code: string,
    severity: EvaluationFinding["severity"],
    confidence: EvaluationFinding["confidence"],
    subsystem: string,
    fact: string,
    guidance: string,
    evidence: string[],
  ): void => {
    findings.push({
      schemaVersion: 1,
      code,
      severity,
      confidence,
      runId: input.runId,
      affectedEvidence: unique(evidence),
      likelySubsystem: subsystem,
      observedFact: fact,
      diagnosticGuidance: guidance,
    });
  };

  if (input.captureDegraded) {
    add(
      "EVAL_CAPTURE_GAP",
      "error",
      "high",
      "evaluation",
      "The recorder reported one or more failed or dropped capture operations.",
      "Treat missing evidence as unknown and inspect session.captureHealth.gaps before drawing causal conclusions.",
      ["session.json"],
    );
  }

  const failedRequests = input.requests.filter((request) => request.outcome === "failed");
  if (failedRequests.length > 0) {
    add(
      "PROVIDER_REQUEST_FAILED",
      "error",
      "high",
      "provider",
      `${failedRequests.length} provider invocation(s) ended in failure.`,
      "Inspect the canonical request, native payload, and sanitized error artifacts for provider, protocol, or capacity causes.",
      failedRequests.map((request) => `requests/${request.requestId}.json`),
    );
  }

  const parseFailures = input.requests.filter((request) => request.parsing?.status === "failed");
  if (parseFailures.length > 0) {
    add(
      "PROVIDER_RESPONSE_PARSE_FAILED",
      "error",
      "high",
      "agent_protocol",
      `${parseFailures.length} provider response(s) reached a terminal parse or protocol failure.`,
      "Inspect the normalized response, repair activity, and schema validation events before changing prompt policy.",
      parseFailures.map((request) => `requests/${request.requestId}.json`),
    );
  }

  const repairs = input.operations.filter((operation) => operation.purpose === "decision_repair");
  if (repairs.length > 0) {
    add(
      "DECISION_REPAIR_REQUIRED",
      repairs.length > 1 ? "warning" : "info",
      "high",
      "agent_harness",
      `${repairs.length} decision repair operation(s) were required.`,
      "Compare the failed response and repair request to determine whether schemas, instructions, or provider behavior caused avoidable protocol work.",
      repairs.map((operation) => `operations/${operation.operationId}.json`),
    );
  }

  const retryOperations = input.operations.filter((operation) => operation.purpose === "provider_retry");
  if (retryOperations.length > 0) {
    add(
      "PROVIDER_RETRY_OBSERVED",
      "warning",
      "high",
      "provider",
      `${retryOperations.length} application-visible provider retry operation(s) occurred.`,
      "Inspect the preceding provider error. SDK-internal retries remain unknown unless exposed by the SDK.",
      retryOperations.map((operation) => `operations/${operation.operationId}.json`),
    );
  }

  const unclassified = input.operations.filter((operation) => operation.purpose === "unclassified");
  if (unclassified.length > 0) {
    add(
      "MODEL_OPERATION_UNCLASSIFIED",
      "warning",
      "high",
      "evaluation",
      `${unclassified.length} model operation(s) reached the provider boundary without an explicit logical purpose.`,
      "Add correlation at the owning model-call site before relying on purpose-level counts for this run.",
      unclassified.map((operation) => `operations/${operation.operationId}.json`),
    );
  }

  const exactToolResults = input.events.filter(({ record }) =>
    record.component === "tool" && record.event === "completed");
  const toolResults = exactToolResults.length > 0
    ? exactToolResults
    : input.events.filter(({ record }) => record.component === "action" && record.event === "tool_result");
  const failedTools = toolResults.filter(({ record, data }) =>
    record.outcome === "failed"
    || Boolean(data?.["error"])
    || data?.["operationStatus"] === "failed");
  if (failedTools.length > 0) {
    add(
      "TOOL_CALL_FAILED",
      "warning",
      "high",
      "tools",
      `${failedTools.length} recorded tool result(s) failed or reported an error.`,
      "Inspect exact input/output artifacts, assertion results, and subsequent repair behavior.",
      failedTools.map(({ record }) => eventEvidence(record)),
    );
  }

  const repeatedTools = repeatedValues(toolResults.map(({ data }) =>
    typeof data?.["tool"] === "string" ? data["tool"] : undefined));
  for (const [tool, count] of repeatedTools) {
    if (count < 3) continue;
    add(
      "REPEATED_TOOL_CALLS",
      "info",
      "medium",
      "agent_harness",
      `Tool ${tool} produced ${count} recorded results in one run.`,
      "Check whether each call advanced evidence or whether tool loading, reads, or retries repeated unchanged work.",
      toolResults.filter(({ data }) => data?.["tool"] === tool).map(({ record }) => eventEvidence(record)),
    );
  }

  const actionCompleted = input.events.filter(({ record }) =>
    record.component === "action" && record.event === "completed");
  const missingVerification = actionCompleted.filter(({ data }) => data?.["verificationPassed"] !== true);
  if (missingVerification.length > 0) {
    add(
      "ACTION_WITHOUT_PASSED_VERIFICATION",
      "warning",
      "high",
      "verification",
      `${missingVerification.length} completed action step(s) did not record passed verification.`,
      "Confirm the final outcome did not rely on these steps and inspect assertion/evidence records.",
      missingVerification.map(({ record }) => eventEvidence(record)),
    );
  }

  const bindings = input.events.filter(({ record }) => record.event === "run_workstream_bound");
  const incompleteBindings = bindings.filter(({ data }) => {
    const binding = nestedRecord(data?.["workstreamBinding"]);
    return !readString(data, "workstreamId")
      && !readString(binding, "workstreamId")
      || !readString(data, "requestId") && !readString(binding, "requestId");
  });
  if (incompleteBindings.length > 0) {
    add(
      "ROUTING_BINDING_INCOMPLETE",
      "error",
      "high",
      "routing",
      `${incompleteBindings.length} workstream binding event(s) lacked a complete workstream/request identity.`,
      "Inspect the deterministic binding proposal and authoritative Context Engine response.",
      incompleteBindings.map(({ record }) => eventEvidence(record)),
    );
  }

  const routingFailures = input.events.filter(({ record }) =>
    record.component === "workstream_binding" && record.event.includes("failed"));
  if (routingFailures.length > 0) {
    add(
      "ROUTING_RESOLUTION_FAILED",
      "error",
      "high",
      "routing",
      `${routingFailures.length} deterministic workstream binding attempt(s) ended in failure.`,
      "Inspect the typed proposal, routing evidence, authoritative Context Engine revision, and the local gate result.",
      routingFailures.map(({ record }) => eventEvidence(record)),
    );
  }

  const bindingStarts = input.events.filter(({ record }) =>
    record.component === "workstream_binding" && record.event === "deterministic_binding_started");
  if (bindingStarts.length > 1) {
    add(
      "MULTIPLE_RESOLVE_GATE_ATTEMPTS",
      "error",
      "high",
      "routing",
      `The run recorded ${bindingStarts.length} deterministic resolve-gate attempts.`,
      "The binding coordinator is run-scoped and must be entered at most once.",
      bindingStarts.map(({ record }) => eventEvidence(record)),
    );
  }
  const modelAttributedGateEvents = input.events.filter(({ record }) =>
    record.component === "workstream_binding"
    && record.event.startsWith("deterministic_binding_")
    && Boolean(record.operationId || record.requestId));
  if (modelAttributedGateEvents.length > 0) {
    add(
      "RESOLVE_GATE_USED_MODEL_CONTEXT",
      "error",
      "high",
      "routing",
      "A deterministic resolve-gate event was attributed to a model operation or provider request.",
      "Keep workstream observation in primary decisions and keep the resolve gate free of model calls.",
      modelAttributedGateEvents.map(({ record }) => eventEvidence(record)),
    );
  }

  const finalizationStarted = input.events.filter(({ record }) => record.event === "run_finalization_started");
  const finalizationCompleted = input.events.filter(({ record }) => record.event === "run_finalization_completed");
  const finalizationFailed = input.events.filter(({ record }) =>
    record.event === "run_finalization_failed"
    || (record.component === "finalization" && record.event === "failed"));
  if (finalizationFailed.length > 0) {
    add(
      "FINALIZATION_FAILED",
      "critical",
      "high",
      "finalization",
      `${finalizationFailed.length} durable finalization failure event(s) were recorded.`,
      "Treat the run as non-durable and inspect the finalization error, binding state, and recovery journal before continuing mutation.",
      finalizationFailed.map(({ record }) => eventEvidence(record)),
    );
  }
  if (finalizationStarted.length > finalizationCompleted.length) {
    add(
      "FINALIZATION_ACKNOWLEDGEMENT_MISSING",
      "error",
      "high",
      "finalization",
      "A run finalization start was recorded without a matching durable completion acknowledgement.",
      "Do not treat the terminal outcome as durable; inspect recovery journals and daemon shutdown ordering.",
      finalizationStarted.map(({ record }) => eventEvidence(record)),
    );
  }
  const inconsistentCommits = finalizationCompleted.filter(({ data }) => {
    const commit = nestedRecord(data?.["workstreamContextCommit"]);
    return commit?.["status"] === "committed"
      && (!readString(commit, "commit")
        || !readString(commit, "headAfter")
        || commit["commit"] !== commit["headAfter"]);
  });
  if (inconsistentCommits.length > 0) {
    add(
      "CONTEXT_COMMIT_IDENTITY_INCONSISTENT",
      "error",
      "high",
      "context_engine",
      `${inconsistentCommits.length} committed finalization acknowledgement(s) lacked matching commit and HEAD identities.`,
      "Inspect Context Engine finalization and context repository recovery before continuing mutation.",
      inconsistentCommits.map(({ record }) => eventEvidence(record)),
    );
  }

  const final = [...input.events].reverse().find(({ record }) =>
    record.component === "final" && ["reply", "dispatched"].includes(record.event));
  const verified = input.events.some(({ record, data }) =>
    record.component === "verification" && record.event === "completed" && readBoolean(data, "verification", "passed"));
  if (final?.data?.["status"] === "completed" && failedTools.length > 0 && !verified) {
    add(
      "COMPLETION_EVIDENCE_MISMATCH",
      "error",
      "medium",
      "finalization",
      "The terminal result was completed after tool failures without an observed passed verification event.",
      "Review WorkState, completion policy evidence, and durable finalization before accepting the completion claim.",
      [eventEvidence(final.record), ...failedTools.map(({ record }) => eventEvidence(record))],
    );
  }

  const contextRequests = input.requests.filter((request) => request.usage?.inputTokens !== undefined);
  const requestsByLane = groupBy(contextRequests, (request) => request.laneId ?? "main");
  for (const laneRequests of requestsByLane.values()) {
    for (let index = 1; index < laneRequests.length; index++) {
      const previous = laneRequests[index - 1]?.usage?.inputTokens ?? 0;
      const current = laneRequests[index]?.usage?.inputTokens ?? 0;
      if (previous > 0 && current > previous * 1.5 && current - previous > 4_000) {
        const request = laneRequests[index]!;
        add(
          "FAST_CONTEXT_GROWTH",
          "warning",
          "high",
          "context_preparation",
          `Provider input grew from ${previous} to ${current} tokens between consecutive requests in lane ${request.laneId ?? "main"}.`,
          "Inspect the context manifest and transformations for duplicated, stale, or unexpectedly protected content.",
          [`requests/${request.requestId}.json`],
        );
      }
    }
  }

  const compilations = input.events.filter(({ record }) =>
    record.component === "decision" && record.event === "context_compilation");
  const compiledMainRequests = contextRequests.filter((request) =>
    ["main_decision", "decision_repair", "final_response"].includes(request.purpose));
  for (let index = 0; index < Math.min(compilations.length, compiledMainRequests.length); index++) {
    const estimate = Number(compilations[index]?.data?.["finalInputTokens"] ?? 0);
    const observed = compiledMainRequests[index]?.usage?.inputTokens ?? 0;
    if (estimate > 1_000 && observed > 0 && Math.abs(observed - estimate) / observed > 0.2) {
      add(
        "TOKEN_ESTIMATE_PROVIDER_MISMATCH",
        "warning",
        "high",
        "token_counting",
        `Local final-input estimate ${estimate} differed from provider usage ${observed} by more than 20%.`,
        "Check provider tokenization, image accounting, and whether the usage field includes the same exact request.",
        [eventEvidence(compilations[index]!.record), `requests/${compiledMainRequests[index]!.requestId}.json`],
      );
    }
  }

  const weakCache = contextRequests.filter((request) =>
    (request.usage?.inputTokens ?? 0) > 10_000
    && (request.usage?.cachedInputTokens ?? 0) / (request.usage?.inputTokens ?? 1) < 0.1);
  if (contextRequests.length > 1 && weakCache.length > 0) {
    add(
      "WEAK_CACHED_PREFIX_REUSE",
      "info",
      "medium",
      "prompt_layout",
      `${weakCache.length} large repeated request(s) reported less than 10% cached input.`,
      "Compare stable system/tool prefixes and provider cache semantics before moving any dynamic context.",
      weakCache.map((request) => `requests/${request.requestId}.json`),
    );
  }

  if (input.currentInput && input.currentInput.length >= 24 && input.canonicalRequests?.length) {
    const relevant = input.canonicalRequests.filter(({ request }) => [
      "main_decision",
      "decision_repair",
      "provider_retry",
      "final_response",
      "proposal_reflection",
    ].includes(request.purpose));
    const appearances = relevant.map(({ request, value }) => ({
      request,
      count: countStringAppearances(value, input.currentInput!),
    }));
    if (appearances.length > 0 && appearances.every((item) => item.count === 0)) {
      add(
        "CURRENT_INPUT_NOT_OBSERVED",
        "error",
        "medium",
        "context_preparation",
        "The exact current input was not found in any foreground canonical request captured for the run.",
        "Inspect prompt manifests and deterministic transformations for input loss; safe capture can make this check unavailable.",
        appearances.map(({ request }) => `requests/${request.requestId}.json`),
      );
    }
    const duplicated = appearances.filter((item) => item.count > 1);
    if (duplicated.length > 0) {
      add(
        "CURRENT_INPUT_DUPLICATED",
        "warning",
        "low",
        "context_preparation",
        `${duplicated.length} canonical request(s) contained the exact current input more than once.`,
        "Compare the current-input lane with recent history before removing content; intentional quotations can produce this low-confidence signal.",
        duplicated.map(({ request }) => `requests/${request.requestId}.json`),
      );
    }
  }

  const exactToolCalls = input.events.filter(({ record, data }) =>
    record.component === "tool" && record.event === "completed" && data?.["input"] !== undefined);
  const callKeys = exactToolCalls.map(({ data }) => `${String(data?.["tool"])}:${canonicalHash(data?.["input"])}`);
  const repeatedExactCalls = repeatedValues(callKeys);
  for (const [key, count] of repeatedExactCalls) {
    if (count < 2) continue;
    add(
      "REPEATED_IDENTICAL_TOOL_CALL",
      "warning",
      "high",
      "tools",
      `The same tool and exact sanitized input were recorded ${count} times in one run (${key.split(":")[0]}).`,
      "Compare outputs and resource versions to determine whether the repeat was a justified retry or avoidable work.",
      exactToolCalls.filter(({ data }) => `${String(data?.["tool"])}:${canonicalHash(data?.["input"])}` === key).map(({ record }) => eventEvidence(record)),
    );
  }

  const workingSets = input.events.filter(({ record, data }) =>
    record.component === "tools" && record.event === "working_set_prepared" && data?.["selected"] !== undefined);
  const repeatedWorkingSets = repeatedValues(workingSets.map(({ data }) => canonicalHash(data?.["selected"])));
  for (const [hash, count] of repeatedWorkingSets) {
    if (count < 3) continue;
    add(
      "REPEATED_TOOL_SURFACE",
      "info",
      "medium",
      "tool_selection",
      `The same selected tool surface was prepared ${count} times in one run.`,
      "Check whether each model iteration or routing retry needed a fresh tool-loading decision.",
      workingSets.filter(({ data }) => canonicalHash(data?.["selected"]) === hash).map(({ record }) => eventEvidence(record)),
    );
  }

  const largeToolSchemas = input.events.filter(({ record, data }) =>
    record.component === "decision"
    && record.event === "context_compilation"
    && Number(data?.["toolSchemaTokens"] ?? 0) > 8_000);
  if (largeToolSchemas.length > 0) {
    add(
      "OVERSIZED_TOOL_SCHEMA_SURFACE",
      "warning",
      "high",
      "tool_selection",
      "At least one request spent more than 8,000 estimated tokens on native tool schemas.",
      "Review selected-tool relevance and schema size while preserving the same authorization rules.",
      largeToolSchemas.map(({ record }) => eventEvidence(record)),
    );
  }

  const ineffectiveCandidates = input.events.filter(({ record, data }) =>
    record.event === "context_candidate_discarded"
    || (record.event === "context_candidate_adopted" && Number(data?.["actualSavingsTokens"] ?? 0) <= 0));
  if (ineffectiveCandidates.length > 0) {
    add(
      "CONTEXT_CANDIDATE_NOT_USEFUL",
      "info",
      "high",
      "context_preparation",
      `${ineffectiveCandidates.length} context candidate(s) were discarded or saved no measured tokens.`,
      "Compare preparation cost, staleness reason, and actual savings before changing trigger thresholds.",
      ineffectiveCandidates.map(({ record }) => eventEvidence(record)),
    );
  }

  const ineffectiveTransformations = compilations.flatMap(({ record, data }) => {
    const transformations = Array.isArray(data?.["transformations"])
      ? data["transformations"].filter((value): value is Record<string, unknown> => Boolean(nestedRecord(value)))
      : [];
    return transformations.filter((transformation) => {
      const before = Number(transformation["tokensBefore"]);
      const after = Number(transformation["tokensAfter"]);
      return Number.isFinite(before) && Number.isFinite(after) && after >= before;
    }).map(() => record);
  });
  if (ineffectiveTransformations.length > 0) {
    add(
      "CONTEXT_TRANSFORMATION_NO_SAVINGS",
      "info",
      "high",
      "context_preparation",
      `${ineffectiveTransformations.length} deterministic context transformation(s) did not reduce measured input tokens.`,
      "Inspect why the transformation was retained and whether its preparation or remeasurement cost was justified.",
      ineffectiveTransformations.map(eventEvidence),
    );
  }

  const serializedBackground = compilations.filter(({ data }) => {
    const preparation = nestedRecord(data?.["backgroundPreparation"]);
    return preparation?.["triggered"] === true && preparation["overlappedForeground"] === false;
  });
  if (serializedBackground.length > 0) {
    add(
      "BACKGROUND_ON_FOREGROUND_PATH",
      "warning",
      "medium",
      "scheduling",
      `${serializedBackground.length} context preparation phase(s) triggered background work without foreground overlap.`,
      "Inspect whether the run explicitly awaited the work at a forced barrier or accidentally serialized independent work.",
      serializedBackground.map(({ record }) => eventEvidence(record)),
    );
  }

  const timedEvidence = [
    ...input.events.flatMap(({ record }) => record.component !== "model_operation"
      && typeof record.durationMs === "number" && record.durationMs > 0
      ? [{ durationMs: record.durationMs, component: record.component, evidence: eventEvidence(record) }]
      : []),
    ...input.requests.flatMap((request) => typeof request.durationMs === "number" && request.durationMs > 0
      ? [{ durationMs: request.durationMs, component: "provider", evidence: `requests/${request.requestId}.json` }]
      : []),
  ];
  const firstTimestamp = input.events[0]?.record.timestampMs;
  const lastTimestamp = input.events.at(-1)?.record.timestampMs;
  const wallMs = firstTimestamp !== undefined && lastTimestamp !== undefined
    ? Math.max(0, lastTimestamp - firstTimestamp)
    : 0;
  const hotspot = timedEvidence.sort((left, right) => right.durationMs - left.durationMs)[0];
  if (hotspot && wallMs >= 1_000 && hotspot.durationMs / wallMs >= 0.5) {
    add(
      "LATENCY_CONCENTRATION",
      "info",
      "high",
      hotspot.component,
      `${hotspot.component} accounted for a ${hotspot.durationMs.toFixed(1)} ms span in a ${wallMs.toFixed(1)} ms run wall interval.`,
      "Use the critical-path waterfall and overlapping spans to decide whether this concentration is expected or a practical hotspot.",
      [hotspot.evidence],
    );
  }

  const terminal = [...input.events].reverse().find(({ record }) =>
    record.component === "final" && ["dispatched", "reply", "error"].includes(record.event));
  if (terminal?.data?.["type"] === "reply" && terminal.data["stopReason"] === "needs_user_input") {
    add(
      "TERMINAL_RESPONSE_SEMANTICS_MISMATCH",
      "warning",
      "high",
      "finalization",
      "The daemon dispatched a reply while the recorded stop reason was needs_user_input.",
      "Use a feedback response with a concrete question when input is required, or record a completed stop reason for a terminal answer.",
      [eventEvidence(terminal.record)],
    );
  }

  return findings.sort((left, right) =>
    severityRank(right.severity) - severityRank(left.severity)
    || confidenceRank(right.confidence) - confidenceRank(left.confidence)
    || left.code.localeCompare(right.code));
}

function eventEvidence(event: EvaluationEvent): string {
  return `events.jsonl#${event.eventId}`;
}

function repeatedValues(values: Array<string | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function readBoolean(data: Record<string, unknown> | undefined, parent: string, key: string): boolean {
  const nested = data?.[parent];
  return Boolean(nested && typeof nested === "object" && (nested as Record<string, unknown>)[key] === true);
}

function nestedRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(data: Record<string, unknown> | undefined, key: string): string | undefined {
  return typeof data?.[key] === "string" && data[key] ? data[key] as string : undefined;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function countStringAppearances(value: unknown, needle: string): number {
  if (typeof value === "string") return occurrences(value, needle);
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countStringAppearances(child, needle), 0);
  if (!value || typeof value !== "object") return 0;
  return Object.values(value as Record<string, unknown>)
    .reduce<number>((sum, child) => sum + countStringAppearances(child, needle), 0);
}

function occurrences(value: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count++;
    offset += Math.max(1, needle.length);
  }
  return count;
}

function groupBy<Value>(values: Value[], keyFor: (value: Value) => string): Map<string, Value[]> {
  const groups = new Map<string, Value[]>();
  for (const value of values) groups.set(keyFor(value), [...(groups.get(keyFor(value)) ?? []), value]);
  return groups;
}

function severityRank(value: EvaluationFinding["severity"]): number {
  return { info: 0, warning: 1, error: 2, critical: 3 }[value];
}

function confidenceRank(value: EvaluationFinding["confidence"]): number {
  return { low: 0, medium: 1, high: 2 }[value];
}
