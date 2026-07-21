import type { LlmProvider } from "../../core/contracts/provider.js";
import type {
  LlmMessage,
  LlmToolCall,
  LlmToolSchema,
  LlmTurnInput,
  LlmTurnOutput,
} from "../../core/contracts/llm-protocol.js";
import type {
  ResolutionDecisionRecord,
  ResolutionStepHistory,
  ResolutionWorkState,
} from "./types.js";
import type { WorkstreamResolutionHint } from "ayati-context-engine";

export const RESOLUTION_READ_ONLY_TOOLS = new Set([
  "resolution_search_workstreams",
  "resolution_read_workstreams",
  "resolution_find_resource_owners",
]);

export const RESOLUTION_TERMINAL_TOOLS = new Set([
  "resolution_activate_workstream",
  "resolution_create_workstream",
  "resolution_needs_user_input",
]);

const RESOLUTION_TOOL_NAMES = new Set([
  ...RESOLUTION_READ_ONLY_TOOLS,
  "resolution_inspect_resource",
  ...RESOLUTION_TERMINAL_TOOLS,
]);

const SYSTEM_PROMPT = `You resolve exactly one workstream and one bounded request for the current Ayati run.
You are an isolated control activity. Do not perform the user's actual task and do not produce a user-facing response.

Rules:
- Use exact workstream ids, exact resource ownership, and explicit continuation as strongest evidence.
- Recent, starred, frequent, or semantic similarity is only a search lead.
- Read only workstream ids already mounted as candidates or returned by a verified resource-owner lookup.
- Read a candidate before selecting it unless exact authoritative evidence already includes its current request and HEAD.
- Continue an existing request only when the current input is the same unfinished outcome.
- Create a new request in an existing workstream for a separate outcome on the same durable subject or resources.
- Create a new workstream only when no existing workstream owns the task and the task is concrete enough to name and verify.
- If multiple workstreams remain plausible, or the input contains unrelated tasks for multiple workstreams, call resolution_needs_user_input.
- Resolve only one workstream/request. Never activate or create two.
- You have the full private tool catalog now. Never request or invent other tools.
- Up to four independent search/read/owner calls may be issued together. Inspect, activate, create, and clarification must be a single call.
- A path, URL, resource id, purpose, or model hint is not authority until a tool verifies it.
- Terminal activate/create calls require short evidence strings describing the verified match.`;

export interface ResolutionDecisionContext {
  activityId: string;
  currentInput: string;
  hints: WorkstreamResolutionHint[];
  previousConversation: Array<{
    role: "user" | "assistant" | "system_event";
    content: string;
  }>;
  ingressResources: unknown[];
  initialCandidates: unknown[];
  priorResolution?: unknown;
  state: ResolutionWorkState;
  history: ResolutionStepHistory[];
  projectedHistory?: {
    candidateIds: string[];
    ownershipIds: string[];
    requestIds: string[];
    heads: string[];
    descriptions: string[];
    evidenceRefs: string[];
  };
  focus?: import("../context-preparation/types.js").RunFocusSummary;
  contextPreparation?: import("../../prompt/context-compilation-receipt.js").ContextCompilationReceipt;
  remaining: {
    turns: number;
    toolCalls: number;
  };
}

export interface ResolutionDecisionOutput {
  decision: ResolutionDecisionRecord;
  raw: LlmTurnOutput;
}

export async function callWorkstreamResolutionDecision(input: {
  provider: LlmProvider;
  context: ResolutionDecisionContext;
  maxParallelCalls: number;
  turnInput?: LlmTurnInput;
}): Promise<ResolutionDecisionOutput> {
  if (!input.provider.capabilities.nativeToolCalling) {
    throw new ResolutionDecisionError(
      "RESOLUTION_NATIVE_TOOLS_REQUIRED",
      `Provider ${input.provider.name} does not support native resolver tools.`,
    );
  }
  const raw = await input.provider.generateTurn(
    input.turnInput ?? buildWorkstreamResolutionTurnInput(input.context),
  );
  if (raw.type !== "tool_calls" || raw.calls.length === 0) {
    throw new ResolutionDecisionError(
      "RESOLUTION_TOOL_CALL_REQUIRED",
      "Resolver must choose one or more private tools through native tool calling.",
      raw,
    );
  }
  let decision: ResolutionDecisionRecord;
  try {
    decision = validateDecisionCalls(raw.calls, input.maxParallelCalls);
  } catch (error) {
    if (error instanceof ResolutionDecisionError) {
      throw new ResolutionDecisionError(error.code, error.message, raw);
    }
    throw error;
  }
  return { decision, raw };
}

export class ResolutionDecisionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly raw?: LlmTurnOutput,
  ) {
    super(message);
    this.name = "ResolutionDecisionError";
  }
}

function validateDecisionCalls(
  calls: LlmToolCall[],
  maxParallelCalls: number,
): ResolutionDecisionRecord {
  if (calls.length > maxParallelCalls) {
    throw new ResolutionDecisionError(
      "RESOLUTION_PARALLEL_LIMIT",
      `Resolver requested ${calls.length} calls; the maximum is ${maxParallelCalls}.`,
    );
  }
  const ids = new Set<string>();
  const normalized = calls.map((call) => {
    if (!RESOLUTION_TOOL_NAMES.has(call.name)) {
      throw new ResolutionDecisionError(
        "RESOLUTION_TOOL_NOT_ALLOWED",
        `Resolver requested private tool '${call.name}' outside its fixed catalog.`,
      );
    }
    if (ids.has(call.id)) {
      throw new ResolutionDecisionError(
        "RESOLUTION_CALL_ID_DUPLICATE",
        `Resolver repeated call id '${call.id}'.`,
      );
    }
    ids.add(call.id);
    if (!isRecord(call.input)) {
      throw new ResolutionDecisionError(
        "RESOLUTION_TOOL_INPUT_INVALID",
        `Resolver tool '${call.name}' requires an object input.`,
      );
    }
    return { id: call.id, tool: call.name, input: call.input };
  });
  if (normalized.length > 1 && normalized.some((call) => !RESOLUTION_READ_ONLY_TOOLS.has(call.tool))) {
    throw new ResolutionDecisionError(
      "RESOLUTION_PARALLEL_MUTATION_FORBIDDEN",
      "Only independent search, read, and ownership calls may execute in parallel.",
    );
  }
  return { calls: normalized };
}

export function buildWorkstreamResolutionTurnInput(
  context: ResolutionDecisionContext,
): LlmTurnInput {
  const messages: LlmMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Resolution context:\n${JSON.stringify(context, null, 2)}`,
    },
  ];
  return {
    messages,
    tools: resolutionToolSchemas(),
    toolChoice: "required",
    parallelToolCalls: true,
  };
}

export function resolutionToolSchemas(): LlmToolSchema[] {
  return [
    {
      name: "resolution_search_workstreams",
      description: "Search the authoritative workstream catalog using text, paths, a view, and current-input continuity. Returns at most twelve explainable candidates.",
      inputSchema: objectSchema({
        query: { type: "string", maxLength: 500 },
        paths: { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } },
        view: { enum: ["relevant", "unfinished", "starred", "recent", "frequent"] },
      }, []),
    },
    {
      name: "resolution_read_workstreams",
      description: "Read up to four candidate workstreams, including their authoritative current request and HEAD.",
      inputSchema: objectSchema({
        workstreamIds: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$" },
        },
      }, ["workstreamIds"]),
    },
    {
      name: "resolution_find_resource_owners",
      description: "Resolve known resource ids, paths, URLs, descriptions, or aliases to owning workstreams.",
      inputSchema: objectSchema({
        query: { type: "string", maxLength: 500 },
        resourceIds: {
          type: "array",
          maxItems: 8,
          items: { type: "string", pattern: "^RES-[0-9A-F]{24}$" },
        },
        locators: { type: "array", maxItems: 8, items: { type: "string" } },
      }, []),
    },
    {
      name: "resolution_inspect_resource",
      description: "Inspect one user-provided filesystem path or URL that is not yet an authoritative resource.",
      inputSchema: objectSchema({
        locator: {
          oneOf: [
            objectSchema({ kind: { const: "filesystem" }, path: { type: "string", minLength: 1 } }, ["kind", "path"]),
            objectSchema({ kind: { const: "url" }, url: { type: "string", minLength: 1 } }, ["kind", "url"]),
          ],
        },
        displayName: { type: "string", maxLength: 200 },
        description: { type: "string", maxLength: 500 },
      }, ["locator"]),
    },
    {
      name: "resolution_activate_workstream",
      description: "Terminally bind one verified existing workstream and either continue its exact request or create one new bounded request.",
      inputSchema: objectSchema({
        workstreamId: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$" },
        expectedWorkstreamHead: { type: "string", minLength: 1 },
        route: {
          oneOf: [
            objectSchema({
              kind: { const: "continue_active_request" },
              requestId: { type: "string", pattern: "^R-[0-9]{4}$" },
              reason: { type: "string", minLength: 1, maxLength: 500 },
            }, ["kind", "requestId", "reason"]),
            objectSchema({
              kind: { const: "create_active_request" },
              reason: { type: "string", minLength: 1, maxLength: 500 },
              title: { type: "string", minLength: 1, maxLength: 120 },
              request: { type: "string", minLength: 1, maxLength: 4000 },
              acceptance: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
              constraints: { type: "array", maxItems: 20, items: { type: "string" } },
            }, ["kind", "reason", "title", "request", "acceptance", "constraints"]),
          ],
        },
        evidence: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } },
      }, ["workstreamId", "expectedWorkstreamHead", "route", "evidence"]),
    },
    {
      name: "resolution_create_workstream",
      description: "Terminally create one workstream and an accurate initial request when no existing workstream owns the concrete task.",
      inputSchema: objectSchema({
        title: { type: "string", minLength: 1, maxLength: 120 },
        objective: { type: "string", minLength: 1, maxLength: 2000 },
        initialRequest: objectSchema({
          title: { type: "string", minLength: 1, maxLength: 120 },
          request: { type: "string", minLength: 1, maxLength: 4000 },
          acceptance: { type: "array", minItems: 1, maxItems: 20, items: { type: "string" } },
          constraints: { type: "array", maxItems: 20, items: { type: "string" } },
        }, ["title", "request", "acceptance", "constraints"]),
        resources: {
          type: "array",
          maxItems: 8,
          items: objectSchema({
            resourceId: { type: "string", pattern: "^RES-[0-9A-F]{24}$" },
            role: { enum: ["input", "reference", "primary", "supporting", "output", "deliverable", "evidence", "asset"] },
            access: { enum: ["read", "mutate"] },
            primary: { type: "boolean" },
          }, ["resourceId", "role", "access"]),
        },
        evidence: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1 } },
      }, ["title", "objective", "initialRequest", "evidence"]),
    },
    {
      name: "resolution_needs_user_input",
      description: "Terminally publish one compact clarification when ownership or single-workstream scope remains ambiguous.",
      inputSchema: objectSchema({
        reasonCodes: { type: "array", minItems: 1, maxItems: 6, items: { type: "string" } },
        question: { type: "string", minLength: 1, maxLength: 500 },
        candidateIds: {
          type: "array",
          maxItems: 3,
          items: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$" },
        },
      }, ["reasonCodes", "question", "candidateIds"]),
    },
  ];
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
