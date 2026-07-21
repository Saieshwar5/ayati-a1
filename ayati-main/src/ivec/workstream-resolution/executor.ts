import type {
  ContextEngineService,
  ResourcePublicLocator,
  WorkstreamCandidate,
  WorkstreamRequestRoute,
} from "ayati-context-engine";
import { ContextEngineServiceError } from "ayati-context-engine";
import { buildContextEngineProjection } from "../../context-engine/index.js";
import { RESOLUTION_READ_ONLY_TOOLS } from "./decision.js";
import type {
  ResolutionDecisionRecord,
  ResolutionToolCallRecord,
  ResolutionWorkState,
  WorkstreamResolutionOutcome,
} from "./types.js";

export interface ExecuteResolutionDecisionInput {
  service: ContextEngineService;
  activityId: string;
  runId: string;
  streamId: string;
  currentInput: string;
  state: ResolutionWorkState;
  decision: ResolutionDecisionRecord;
  at: string;
}

export interface ExecuteResolutionDecisionOutput {
  records: ResolutionToolCallRecord[];
  terminal?: WorkstreamResolutionOutcome;
}

export async function executeResolutionDecision(
  input: ExecuteResolutionDecisionInput,
): Promise<ExecuteResolutionDecisionOutput> {
  if (input.decision.calls.length > 1) {
    if (input.decision.calls.some((call) => !RESOLUTION_READ_ONLY_TOOLS.has(call.tool))) {
      return {
        records: input.decision.calls.map((call) => failedRecord(
          call,
          "RESOLUTION_PARALLEL_MUTATION_FORBIDDEN",
          "Only search, read, and ownership tools may run in parallel.",
          false,
        )),
      };
    }
    const settled = await Promise.allSettled(
      input.decision.calls.map(async (call) => await executeSingle(input, call)),
    );
    return {
      records: settled.map((result, index) => {
        if (result.status === "fulfilled") return result.value.record;
        return failureFromError(input.decision.calls[index]!, result.reason);
      }),
    };
  }

  const call = input.decision.calls[0];
  if (!call) return { records: [] };
  try {
    const executed = await executeSingle(input, call);
    return {
      records: [executed.record],
      ...(executed.terminal ? { terminal: executed.terminal } : {}),
    };
  } catch (error) {
    return { records: [failureFromError(call, error)] };
  }
}

async function executeSingle(
  context: ExecuteResolutionDecisionInput,
  call: ResolutionDecisionRecord["calls"][number],
): Promise<{
  record: ResolutionToolCallRecord;
  terminal?: WorkstreamResolutionOutcome;
}> {
  switch (call.tool) {
    case "resolution_search_workstreams": {
      const query = optionalString(call.input["query"], 500);
      const paths = stringArray(call.input["paths"], 8);
      const view = resolutionView(call.input["view"]);
      const result = await context.service.findWorkstreams({
        ...(query ? { query } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(view ? { view } : {}),
        streamId: context.streamId,
        currentText: context.currentInput,
        limit: 12,
      });
      return { record: completedRecord(call, result) };
    }
    case "resolution_read_workstreams": {
      const workstreamIds = requiredStringArray(call.input["workstreamIds"], "workstreamIds", 4);
      verifyReadTargetsAllowed(context.state, workstreamIds);
      const reads = await Promise.allSettled(workstreamIds.map(async (workstreamId, index) =>
        await context.service.readWorkstream({
          requestId: `${context.activityId}:read:${call.id}:${index + 1}`,
          runId: context.runId,
          workstreamId,
          at: context.at,
        })));
      const workstreams = reads.map((result, index) => result.status === "fulfilled"
        ? { status: "completed" as const, workstreamId: workstreamIds[index], ...result.value }
        : {
            status: "failed" as const,
            workstreamId: workstreamIds[index],
            error: errorDetails(result.reason),
          });
      return { record: completedRecord(call, { workstreams }) };
    }
    case "resolution_find_resource_owners": {
      const query = optionalString(call.input["query"], 500);
      const resourceIds = stringArray(call.input["resourceIds"], 8);
      const locators = stringArray(call.input["locators"], 8);
      if (!query && resourceIds.length === 0 && locators.length === 0) {
        throw invalid("Resource ownership lookup needs a query, resource id, or locator.");
      }
      const result = await context.service.findResources({
        ...(query ? { query } : {}),
        ...(resourceIds.length > 0 ? { resourceIds } : {}),
        ...(locators.length > 0 ? { locators } : {}),
        limit: 12,
      });
      return { record: completedRecord(call, result) };
    }
    case "resolution_inspect_resource": {
      const locator = resourceLocator(call.input["locator"]);
      const result = await context.service.inspectResourceForRun({
        requestId: `${context.activityId}:inspect:${call.id}`,
        runId: context.runId,
        locator,
        origin: "user_reference",
        ...(optionalString(call.input["displayName"], 200)
          ? { displayName: optionalString(call.input["displayName"], 200) }
          : {}),
        ...(optionalString(call.input["description"], 500)
          ? { description: optionalString(call.input["description"], 500) }
          : {}),
        at: context.at,
      });
      return { record: completedRecord(call, result) };
    }
    case "resolution_activate_workstream": {
      const workstreamId = requiredString(call.input["workstreamId"], "workstreamId", 64);
      const expectedWorkstreamHead = requiredString(
        call.input["expectedWorkstreamHead"],
        "expectedWorkstreamHead",
        200,
      );
      const evidence = requiredStringArray(call.input["evidence"], "evidence", 12);
      verifyExistingSelection(context.state, workstreamId, expectedWorkstreamHead, evidence);
      const route = workstreamRoute(call.input["route"]);
      const response = await context.service.commitWorkstreamResolution({
        requestId: `${context.activityId}:commit`,
        activityId: context.activityId,
        runId: context.runId,
        commit: {
          kind: "activate",
          workstreamId,
          expectedWorkstreamHead,
          route,
          evidence,
        },
        finalState: {
          ...context.state,
          status: "resolved",
          proposedSelection: {
            workstreamId,
            requestKind: route.kind === "continue_active_request" ? "continue" : "create",
            evidence,
          },
        },
        at: context.at,
      });
      const projected = buildContextEngineProjection(response.context);
      return {
        record: completedRecord(call, response.receipt),
        terminal: {
          receipt: {
            status: "resolved",
            activityId: context.activityId,
            resolutionKind: response.receipt.kind,
            workstreamId: response.receipt.workstreamId,
            requestId: response.receipt.requestId,
            stepCount: response.activity.stepCount + 1,
            contextRevision: response.context.contextRevision,
          },
          context: projected,
        },
      };
    }
    case "resolution_create_workstream": {
      verifyCreationAllowed(context.state);
      const title = requiredString(call.input["title"], "title", 120);
      const objective = requiredString(call.input["objective"], "objective", 2_000);
      const initialRequest = requestDefinition(call.input["initialRequest"]);
      const evidence = requiredStringArray(call.input["evidence"], "evidence", 12);
      const resources = resolutionResourceBindings(call.input["resources"]);
      const response = await context.service.commitWorkstreamResolution({
        requestId: `${context.activityId}:commit`,
        activityId: context.activityId,
        runId: context.runId,
        commit: {
          kind: "create",
          title,
          objective,
          initialRequest,
          ...(resources.length > 0 ? { resources } : {}),
          evidence,
        },
        finalState: {
          ...context.state,
          status: "resolved",
          proposedCreation: { title, objective },
        },
        at: context.at,
      });
      return {
        record: completedRecord(call, response.receipt),
        terminal: {
          receipt: {
            status: "resolved",
            activityId: context.activityId,
            resolutionKind: response.receipt.kind,
            workstreamId: response.receipt.workstreamId,
            requestId: response.receipt.requestId,
            stepCount: response.activity.stepCount + 1,
            contextRevision: response.context.contextRevision,
          },
          context: buildContextEngineProjection(response.context),
        },
      };
    }
    case "resolution_needs_user_input": {
      const reasonCodes = requiredStringArray(call.input["reasonCodes"], "reasonCodes", 6);
      const question = requiredString(call.input["question"], "question", 500);
      const candidateIds = stringArray(call.input["candidateIds"], 3);
      const candidates = selectCandidates(context.state.candidates, candidateIds);
      const result = {
        status: "needs_user_input" as const,
        reasonCodes,
        question,
        candidates,
      };
      const response = await context.service.finishWorkstreamResolution({
        requestId: `${context.activityId}:needs-user-input`,
        activityId: context.activityId,
        runId: context.runId,
        result,
        finalState: {
          ...context.state,
          status: "needs_user_input",
          ambiguity: { reasonCodes, candidateIds, question },
        },
        at: context.at,
      });
      return {
        record: completedRecord(call, {
          status: result.status,
          candidateCount: candidates.length,
        }),
        terminal: {
          receipt: {
            status: "needs_user_input",
            activityId: context.activityId,
            candidateCount: candidates.length,
            stepCount: response.activity.stepCount + 1,
            contextRevision: response.context.contextRevision,
          },
          context: buildContextEngineProjection(response.context),
        },
      };
    }
    default:
      throw invalid(`Unknown resolver tool '${call.tool}'.`);
  }
}

function verifyReadTargetsAllowed(
  state: ResolutionWorkState,
  workstreamIds: string[],
): void {
  const knownIds = new Set([
    ...state.candidates.map((candidate) => candidate.candidate.workstreamId),
    ...state.resourceOwnership
      .filter((ownership) => ownership.verified)
      .flatMap((ownership) => ownership.workstreamIds),
  ]);
  const unknown = workstreamIds.filter((workstreamId) => !knownIds.has(workstreamId));
  if (unknown.length > 0) {
    throw invalid(
      `Workstream reads require ids from mounted candidates or verified resource ownership: ${unknown.join(", ")}.`,
    );
  }
}

function verifyExistingSelection(
  state: ResolutionWorkState,
  workstreamId: string,
  expectedHead: string,
  evidence: string[],
): void {
  const candidate = state.candidates.find((item) => item.candidate.workstreamId === workstreamId);
  if (!candidate) throw invalid("Activation requires a candidate returned by authoritative discovery.");
  if (candidate.candidate.head !== expectedHead) {
    throw invalid("Activation HEAD does not match the inspected candidate.");
  }
  const reasons = candidate.candidate.discovery.reasons;
  const exact = reasons.some((reason) => [
    "exact_workstream_id",
    "exact_resource_id",
    "owned_resource",
    "direct_continuation",
  ].includes(reason));
  if (!exact && !candidate.inspected) {
    throw invalid("Semantic or recency candidates must be read before activation.");
  }
  if (evidence.length === 0) throw invalid("Activation requires verified selection evidence.");
}

function verifyCreationAllowed(state: ResolutionWorkState): void {
  const searchedAuthoritativeState = state.searches.some((search) => search.completed)
    || state.resourceOwnership.some((ownership) => ownership.verified);
  if (!searchedAuthoritativeState) {
    throw invalid("Creation requires at least one authoritative workstream search or resource-owner lookup.");
  }
  const strongCandidate = state.candidates.some((candidate) =>
    candidate.candidate.discovery.tier !== "candidate");
  if (strongCandidate) {
    throw invalid("A probable or definite candidate must be activated or presented for clarification; creating a duplicate is not allowed.");
  }
}

function selectCandidates(
  candidates: ResolutionWorkState["candidates"],
  candidateIds: string[],
): WorkstreamCandidate[] {
  const byId = new Map(candidates.map((candidate) => [candidate.candidate.workstreamId, candidate.candidate]));
  const selected = candidateIds.map((id) => byId.get(id)).filter((value): value is WorkstreamCandidate => Boolean(value));
  if (selected.length !== candidateIds.length) {
    throw invalid("Clarification candidates must come from authoritative resolver discovery.");
  }
  return selected;
}

function workstreamRoute(value: unknown): WorkstreamRequestRoute {
  const record = requiredRecord(value, "route");
  const kind = record["kind"];
  const reason = requiredString(record["reason"], "route.reason", 500);
  if (kind === "continue_active_request") {
    return {
      kind,
      requestId: requiredString(record["requestId"], "route.requestId", 32),
      reason,
    };
  }
  if (kind === "create_active_request") {
    return {
      kind,
      reason,
      title: requiredString(record["title"], "route.title", 120),
      request: requiredString(record["request"], "route.request", 4_000),
      acceptance: requiredStringArray(record["acceptance"], "route.acceptance", 20),
      constraints: stringArray(record["constraints"], 20),
    };
  }
  throw invalid("Resolution route kind is invalid.");
}

function requestDefinition(value: unknown): {
  title: string;
  request: string;
  acceptance: string[];
  constraints: string[];
} {
  const record = requiredRecord(value, "initialRequest");
  return {
    title: requiredString(record["title"], "initialRequest.title", 120),
    request: requiredString(record["request"], "initialRequest.request", 4_000),
    acceptance: requiredStringArray(record["acceptance"], "initialRequest.acceptance", 20),
    constraints: stringArray(record["constraints"], 20),
  };
}

function resolutionResourceBindings(value: unknown): Array<{
  resourceId: string;
  role: "input" | "reference" | "primary" | "supporting" | "output" | "deliverable" | "evidence" | "asset";
  access: "read" | "mutate";
  primary?: boolean;
}> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw invalid("resources must be an array of at most eight bindings.");
  return value.map((item, index) => {
    const record = requiredRecord(item, `resources[${index}]`);
    const role = record["role"];
    const access = record["access"];
    if (!["input", "reference", "primary", "supporting", "output", "deliverable", "evidence", "asset"].includes(String(role))) {
      throw invalid(`resources[${index}].role is invalid.`);
    }
    if (access !== "read" && access !== "mutate") {
      throw invalid(`resources[${index}].access is invalid.`);
    }
    return {
      resourceId: requiredString(record["resourceId"], `resources[${index}].resourceId`, 64),
      role: role as "input" | "reference" | "primary" | "supporting" | "output" | "deliverable" | "evidence" | "asset",
      access,
      ...(typeof record["primary"] === "boolean" ? { primary: record["primary"] } : {}),
    };
  });
}

function resourceLocator(value: unknown): ResourcePublicLocator {
  const record = requiredRecord(value, "locator");
  if (record["kind"] === "filesystem") {
    return { kind: "filesystem", path: requiredString(record["path"], "locator.path", 4_000) };
  }
  if (record["kind"] === "url") {
    const url = requiredString(record["url"], "locator.url", 4_000);
    try {
      return { kind: "url", url: new URL(url).toString() };
    } catch {
      throw invalid("locator.url must be an absolute URL.");
    }
  }
  throw invalid("Resolver resource locator must be filesystem or URL.");
}

function completedRecord(
  call: ResolutionDecisionRecord["calls"][number],
  output: unknown,
): ResolutionToolCallRecord {
  return {
    id: call.id,
    tool: call.tool,
    input: call.input,
    status: "completed",
    output,
  };
}

function failureFromError(
  call: ResolutionDecisionRecord["calls"][number],
  error: unknown,
): ResolutionToolCallRecord {
  const details = errorDetails(error);
  return failedRecord(call, details.code, details.message, details.retryable);
}

function failedRecord(
  call: ResolutionDecisionRecord["calls"][number],
  code: string,
  message: string,
  retryable: boolean,
): ResolutionToolCallRecord {
  return {
    id: call.id,
    tool: call.tool,
    input: call.input,
    status: "failed",
    error: { code, message, retryable },
  };
}

function errorDetails(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof ContextEngineServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: error instanceof ResolutionExecutionError ? error.code : "RESOLUTION_TOOL_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

class ResolutionExecutionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResolutionExecutionError";
  }
}

function invalid(message: string): ResolutionExecutionError {
  return new ResolutionExecutionError("RESOLUTION_TOOL_INPUT_INVALID", message);
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, maximum: number): string {
  const normalized = optionalString(value, maximum);
  if (!normalized) throw invalid(`${field} is required.`);
  return normalized;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid("Expected a string value.");
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length === 0 || normalized.length > maximum) {
    throw invalid(`String value must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function stringArray(value: unknown, maximum: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalid(`Expected an array with at most ${maximum} strings.`);
  }
  return value.map((item) => requiredString(item, "array item", 4_000));
}

function requiredStringArray(value: unknown, field: string, maximum: number): string[] {
  const values = stringArray(value, maximum);
  if (values.length === 0) throw invalid(`${field} requires at least one item.`);
  return values;
}

function resolutionView(value: unknown): "relevant" | "unfinished" | "starred" | "recent" | "frequent" | undefined {
  return ["relevant", "unfinished", "starred", "recent", "frequent"].includes(String(value))
    ? value as "relevant" | "unfinished" | "starred" | "recent" | "frequent"
    : undefined;
}
