import type {
  WorkstreamBindingProposal,
  WorkstreamRequestDecision,
  WorkstreamRequestDefinition,
} from "./contracts.js";

const WORKSTREAM_ID_PATTERN = "^W-[0-9]{8}-[0-9]{4}$";
const REQUEST_ID_PATTERN = "^R-[0-9]{4}$";
const RESOURCE_ID_PATTERN = "^RES-[0-9A-F]{24}$";

export function normalizeWorkstreamBindingProposal(
  value: unknown,
): WorkstreamBindingProposal | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (record["kind"] === "activate") return normalizeActivateProposal(record);
  if (record["kind"] === "create") return normalizeCreateProposal(record);
  return undefined;
}

function normalizeActivateProposal(
  record: Record<string, unknown>,
): WorkstreamBindingProposal | undefined {
  const workstreamId = stringValue(record["workstreamId"]);
  const requestDecision = normalizeRequestDecision(record["requestDecision"]);
  const resourceIds = resourceIdArray(record["resourceIds"]);
  if (!workstreamId || !requestDecision || !resourceIds) {
    return undefined;
  }
  return {
    kind: "activate",
    workstreamId,
    requestDecision,
    resourceIds,
  };
}

function normalizeCreateProposal(
  record: Record<string, unknown>,
): WorkstreamBindingProposal | undefined {
  const title = stringValue(record["title"]);
  const objective = stringValue(record["objective"]);
  const initialRequest = normalizeRequestDefinition(record["initialRequest"]);
  if (!title || !objective || !initialRequest) {
    return undefined;
  }
  return {
    kind: "create",
    title,
    objective,
    initialRequest,
  };
}

function normalizeRequestDecision(value: unknown): WorkstreamRequestDecision | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const reason = stringValue(record["reason"]);
  if (!reason) return undefined;
  if (record["kind"] === "continue_current"
    || record["kind"] === "activate_existing"
    || record["kind"] === "resume_blocked") {
    const requestId = stringValue(record["requestId"]);
    return requestId && /^R-[0-9]{4}$/.test(requestId)
      ? { kind: record["kind"], requestId, reason }
      : undefined;
  }
  if (record["kind"] === "amend_current") {
    const currentRequestId = stringValue(record["currentRequestId"]);
    const patch = normalizeRequestPatch(record["patch"]);
    const authority = record["authority"];
    return currentRequestId
      && /^R-[0-9]{4}$/.test(currentRequestId)
      && patch
      && (authority === "user" || authority === "trusted_policy")
      ? { kind: record["kind"], currentRequestId, patch, authority, reason }
      : undefined;
  }
  if (record["kind"] === "create_and_activate" || record["kind"] === "create_queued") {
    const definition = normalizeRequestDefinition(record);
    return definition ? { kind: record["kind"], ...definition, reason } : undefined;
  }
  if (record["kind"] === "defer_current_and_create") {
    const currentRequestId = stringValue(record["currentRequestId"]);
    const definition = normalizeRequestDefinition(record);
    return currentRequestId && /^R-[0-9]{4}$/.test(currentRequestId) && definition
      ? { kind: record["kind"], currentRequestId, ...definition, reason }
      : undefined;
  }
  if (record["kind"] === "defer_current_and_activate_existing") {
    const currentRequestId = stringValue(record["currentRequestId"]);
    const nextRequestId = stringValue(record["nextRequestId"]);
    return currentRequestId && nextRequestId
      && /^R-[0-9]{4}$/.test(currentRequestId)
      && /^R-[0-9]{4}$/.test(nextRequestId)
      ? { kind: record["kind"], currentRequestId, nextRequestId, reason }
      : undefined;
  }
  return undefined;
}

function normalizeRequestPatch(
  value: unknown,
): Partial<WorkstreamRequestDefinition> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const keys = Object.keys(record);
  if (keys.length === 0
    || keys.some((key) => !["title", "request", "acceptance", "constraints"].includes(key))) {
    return undefined;
  }
  const title = record["title"] === undefined ? undefined : stringValue(record["title"]);
  const request = record["request"] === undefined ? undefined : stringValue(record["request"]);
  const acceptance = record["acceptance"] === undefined
    ? undefined
    : stringArray(record["acceptance"]);
  const constraints = record["constraints"] === undefined
    ? undefined
    : stringArray(record["constraints"]);
  if ((record["title"] !== undefined && !title)
    || (record["request"] !== undefined && !request)
    || (record["acceptance"] !== undefined && !acceptance?.length)) {
    return undefined;
  }
  return {
    ...(title ? { title } : {}),
    ...(request ? { request } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(constraints ? { constraints } : {}),
  };
}

function normalizeRequestDefinition(value: unknown): WorkstreamRequestDefinition | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const title = stringValue(record["title"]);
  const request = stringValue(record["request"]);
  const acceptance = stringArray(record["acceptance"]);
  const constraints = stringArray(record["constraints"]);
  return title && request && acceptance.length > 0
    ? { title, request, acceptance, constraints }
    : undefined;
}

export function workstreamActivateProposalSchema(): Record<string, unknown> {
  return objectSchema({
    workstreamId: { type: "string", pattern: WORKSTREAM_ID_PATTERN },
    requestDecision: {
      description:
        "Choose one explicit lifecycle operation. Continue only the same contract; amend only the same independently acceptable outcome; create a new request for a separate outcome; defer instead of falsely blocking unfinished work.",
      oneOf: [
        existingRequestDecisionSchema("continue_current"),
        existingRequestDecisionSchema("activate_existing"),
        existingRequestDecisionSchema("resume_blocked"),
        amendRequestDecisionSchema(),
        createRequestDecisionSchema("create_and_activate"),
        createRequestDecisionSchema("create_queued"),
        deferAndCreateDecisionSchema(),
        deferAndActivateDecisionSchema(),
      ],
    },
    resourceIds: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "string",
        pattern: RESOURCE_ID_PATTERN,
      },
      description:
        "Exact existing resource IDs returned by current-run routing. These select current-run mutation authority; the runtime derives paths, ownership, repository HEAD, and evidence from authoritative activated context.",
    },
  }, ["workstreamId", "requestDecision", "resourceIds"]);
}

export function workstreamCreateProposalSchema(): Record<string, unknown> {
  return objectSchema({
    title: { type: "string", minLength: 1, maxLength: 120 },
    objective: { type: "string", minLength: 1, maxLength: 2000 },
    initialRequest: requestDefinitionSchema(),
  }, ["title", "objective", "initialRequest"]);
}

function existingRequestDecisionSchema(
  kind: "continue_current" | "activate_existing" | "resume_blocked",
): Record<string, unknown> {
  return objectSchema({
    kind: { const: kind },
    requestId: {
      type: "string",
      pattern: REQUEST_ID_PATTERN,
      description: "The exact request ID observed during workstream inspection.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Why this exact lifecycle operation matches the user's intention.",
    },
  }, [
    "kind",
    "requestId",
    "reason",
  ], "Use only when the observed request status permits this exact operation.");
}

function createRequestDecisionSchema(
  kind: "create_and_activate" | "create_queued",
): Record<string, unknown> {
  return objectSchema({
    kind: { const: kind },
    title: { type: "string", minLength: 1, maxLength: 120 },
    request: { type: "string", minLength: 1, maxLength: 4000 },
    acceptance: boundedStringArray(20),
    constraints: boundedStringArray(20),
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Why this is a separately acceptable outcome in the same workstream.",
    },
  }, [
    "kind",
    "title",
    "request",
    "acceptance",
    "constraints",
    "reason",
  ], kind === "create_and_activate"
    ? "Create and activate only when no request is active."
    : "Create queued work for later without changing the active request.");
}

function deferAndCreateDecisionSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "defer_current_and_create" },
    currentRequestId: {
      type: "string",
      pattern: REQUEST_ID_PATTERN,
      description: "The exact active request ID to return to queued status.",
    },
    title: { type: "string", minLength: 1, maxLength: 120 },
    request: { type: "string", minLength: 1, maxLength: 4000 },
    acceptance: boundedStringArray(20),
    constraints: boundedStringArray(20),
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "Why the user explicitly wants the new request to become active now.",
    },
  }, [
    "kind",
    "currentRequestId",
    "title",
    "request",
    "acceptance",
    "constraints",
    "reason",
  ], "Defer the unfinished active request and create a separate active outcome.");
}

function deferAndActivateDecisionSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "defer_current_and_activate_existing" },
    currentRequestId: { type: "string", pattern: REQUEST_ID_PATTERN },
    nextRequestId: { type: "string", pattern: REQUEST_ID_PATTERN },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  }, [
    "kind",
    "currentRequestId",
    "nextRequestId",
    "reason",
  ], "Defer the current request and activate an existing queued request.");
}

function amendRequestDecisionSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "amend_current" },
    currentRequestId: { type: "string", pattern: REQUEST_ID_PATTERN },
    authority: { enum: ["user", "trusted_policy"] },
    patch: {
      type: "object",
      minProperties: 1,
      properties: {
        title: { type: "string", minLength: 1, maxLength: 120 },
        request: { type: "string", minLength: 1, maxLength: 4000 },
        acceptance: {
          ...boundedStringArray(20),
          minItems: 1,
        },
        constraints: boundedStringArray(20),
      },
      additionalProperties: false,
    },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  }, [
    "kind",
    "currentRequestId",
    "authority",
    "patch",
    "reason",
  ], "Amend only when the durable outcome remains the same.");
}

function requestDefinitionSchema(): Record<string, unknown> {
  return objectSchema({
    title: { type: "string", minLength: 1, maxLength: 120 },
    request: { type: "string", minLength: 1, maxLength: 4000 },
    acceptance: boundedStringArray(20),
    constraints: boundedStringArray(20),
  }, ["title", "request", "acceptance", "constraints"]);
}

function boundedStringArray(maxItems: number): Record<string, unknown> {
  return {
    type: "array",
    maxItems,
    items: { type: "string", minLength: 1, maxLength: 500 },
  };
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
  description?: string,
): Record<string, unknown> {
  return {
    type: "object",
    ...(description ? { description } : {}),
    properties,
    required,
    additionalProperties: false,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.flatMap((item) => {
        const normalized = stringValue(item);
        return normalized ? [normalized] : [];
      }))]
    : [];
}

function resourceIdArray(value: unknown): string[] | undefined {
  const values = stringArray(value);
  return values.length > 0
    && values.length <= 8
    && values.every((item) => /^RES-[0-9A-F]{24}$/.test(item))
    ? values
    : undefined;
}
