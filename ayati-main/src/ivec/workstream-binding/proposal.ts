import type {
  WorkstreamBindingProposal,
  WorkstreamRequestDecision,
  WorkstreamRequestDefinition,
  WorkstreamResourceBindingProposal,
  WorkstreamResourceRole,
} from "./contracts.js";

const WORKSTREAM_ID_PATTERN = "^W-[0-9]{8}-[0-9]{4}$";
const REQUEST_ID_PATTERN = "^R-[0-9]{4}$";
const RESOURCE_ID_PATTERN = "^RES-[0-9A-F]{24}$";

export function workstreamBindingProposalSchema(): Record<string, unknown> {
  return {
    oneOf: [activateProposalSchema(), createProposalSchema()],
    description: "Required only when entering resolve on an unbound run. Propose one exact evidence-backed binding; the harness verifies and commits it deterministically.",
  };
}

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
  const expectedWorkstreamHead = stringValue(record["expectedWorkstreamHead"]);
  const requestDecision = normalizeRequestDecision(record["requestDecision"]);
  const evidence = stringArray(record["evidence"]);
  if (!workstreamId || !expectedWorkstreamHead || !requestDecision || evidence.length === 0) {
    return undefined;
  }
  return {
    kind: "activate",
    workstreamId,
    expectedWorkstreamHead,
    requestDecision,
    evidence,
  };
}

function normalizeCreateProposal(
  record: Record<string, unknown>,
): WorkstreamBindingProposal | undefined {
  const title = stringValue(record["title"]);
  const objective = stringValue(record["objective"]);
  const initialRequest = normalizeRequestDefinition(record["initialRequest"]);
  const resources = normalizeResourceBindings(record["resources"]);
  const evidence = stringArray(record["evidence"]);
  if (!title || !objective || !initialRequest || resources === undefined || evidence.length === 0) {
    return undefined;
  }
  return {
    kind: "create",
    title,
    objective,
    initialRequest,
    resources,
    evidence,
  };
}

function normalizeRequestDecision(value: unknown): WorkstreamRequestDecision | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const reason = stringValue(record["reason"]);
  if (!reason) return undefined;
  if (record["kind"] === "continue") {
    const requestId = stringValue(record["requestId"]);
    return requestId ? { kind: "continue", requestId, reason } : undefined;
  }
  if (record["kind"] === "create") {
    const definition = normalizeRequestDefinition(record);
    return definition ? { kind: "create", ...definition, reason } : undefined;
  }
  return undefined;
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

function normalizeResourceBindings(
  value: unknown,
): WorkstreamResourceBindingProposal[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) return undefined;
  const resources: WorkstreamResourceBindingProposal[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const resourceId = stringValue(record?.["resourceId"]);
    const role = resourceRole(record?.["role"]);
    const access = record?.["access"];
    if (!resourceId || !role || (access !== "read" && access !== "mutate")) return undefined;
    resources.push({
      resourceId,
      role,
      access,
      ...(record?.["primary"] === true ? { primary: true } : {}),
    });
  }
  return resources;
}

function activateProposalSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "activate" },
    workstreamId: { type: "string", pattern: WORKSTREAM_ID_PATTERN },
    expectedWorkstreamHead: { type: "string", minLength: 1, maxLength: 200 },
    requestDecision: {
      oneOf: [continueDecisionSchema(), createRequestDecisionSchema()],
    },
    evidence: evidenceSchema(),
  }, ["kind", "workstreamId", "expectedWorkstreamHead", "requestDecision", "evidence"]);
}

function createProposalSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "create" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    objective: { type: "string", minLength: 1, maxLength: 2000 },
    initialRequest: requestDefinitionSchema(),
    resources: {
      type: "array",
      maxItems: 8,
      items: resourceBindingSchema(),
    },
    evidence: evidenceSchema(),
  }, ["kind", "title", "objective", "initialRequest", "resources", "evidence"]);
}

function continueDecisionSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "continue" },
    requestId: { type: "string", pattern: REQUEST_ID_PATTERN },
    reason: { type: "string", minLength: 1, maxLength: 500 },
  }, ["kind", "requestId", "reason"]);
}

function createRequestDecisionSchema(): Record<string, unknown> {
  return objectSchema({
    kind: { const: "create" },
    title: { type: "string", minLength: 1, maxLength: 120 },
    request: { type: "string", minLength: 1, maxLength: 4000 },
    acceptance: boundedStringArray(20),
    constraints: boundedStringArray(20),
    reason: { type: "string", minLength: 1, maxLength: 500 },
  }, ["kind", "title", "request", "acceptance", "constraints", "reason"]);
}

function requestDefinitionSchema(): Record<string, unknown> {
  return objectSchema({
    title: { type: "string", minLength: 1, maxLength: 120 },
    request: { type: "string", minLength: 1, maxLength: 4000 },
    acceptance: boundedStringArray(20),
    constraints: boundedStringArray(20),
  }, ["title", "request", "acceptance", "constraints"]);
}

function resourceBindingSchema(): Record<string, unknown> {
  return objectSchema({
    resourceId: { type: "string", pattern: RESOURCE_ID_PATTERN },
    role: {
      enum: ["input", "reference", "primary", "supporting", "output", "deliverable", "evidence", "asset"],
    },
    access: { enum: ["read", "mutate"] },
    primary: { type: "boolean" },
  }, ["resourceId", "role", "access"]);
}

function evidenceSchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 12,
    items: { type: "string", minLength: 1, maxLength: 500 },
  };
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
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
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

function resourceRole(value: unknown): WorkstreamResourceRole | undefined {
  return [
    "input",
    "reference",
    "primary",
    "supporting",
    "output",
    "deliverable",
    "evidence",
    "asset",
  ].includes(String(value))
    ? value as WorkstreamResourceRole
    : undefined;
}
