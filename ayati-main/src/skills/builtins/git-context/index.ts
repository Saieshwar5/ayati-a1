import type {
  ContextEngineService,
  ResourceRole,
  SelectedWorkstreamForRunResponse,
  WorkstreamRequestRoute,
} from "ayati-context-engine";
import { buildContextEngineProjection } from "../../../context-engine/index.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";
import { createWorkstreamDiscoveryTools } from "./discovery-tools.js";
import { createAgentHistoryTools } from "./history-tools.js";

export interface GitContextSkillDeps {
  service: ContextEngineService;
}

const PROMPT = [
  "A workstream is durable context for a long-lived subject, goal, or maintained body of work. It is not the project directory.",
  "A request is one bounded outcome inside a workstream. A run is only the current compute, audit, and recovery boundary.",
  "Real files, directories, URLs, repositories, media, databases, and external objects are resources linked to workstreams.",
  "The workstream context repository contains only Ayati-maintained context. Never write deliverables into it.",
  "When the user gives no destination, creating a workstream also creates one user-visible primary output directory under the Ayati workspace.",
  "When the user names an existing path or resource, inspect it and bind that exact resource instead of moving it or initializing Git inside it.",
  "Continue the active request only for the same unfinished outcome. Create a new request in the same workstream for a materially separate outcome on the same durable subject or resources.",
  "Use git_context_find_workstreams and git_context_read_workstream when compact candidates do not prove ownership.",
  "Use git_context_find_resources to locate work by an artifact, path, URL, description, or alias.",
  "Use agent_history_search for older discussion, run summaries, or evidence omitted from the bounded stream projection. Use agent_history_read with the exact returned ref or sequence range.",
  "Use git_context_activate_workstream for existing ownership and git_context_create_workstream for genuinely distinct durable work.",
  "Casual conversation and isolated list, search, or read work may remain unbound. Persistent mutation requires one immutable workstream/request binding.",
  "Never choose by recency alone. Exact workstream identity, exact resource identity, and explicit continuation are strongest; ask one focused question if mutation ownership remains ambiguous.",
  "Stars are user-controlled and may change only when the current user message explicitly requests it.",
  "After binding, use the returned resource locators. Mutation authority is granted only for exact mutable resources and exact targets.",
].join("\n");

export function createGitContextSkill(deps: GitContextSkillDeps): SkillDefinition {
  return {
    id: "git-context",
    version: "5.0.0",
    description: "Inspect agent-stream history and discover, create, or continue durable workstreams linked to real resources.",
    promptBlock: PROMPT,
    tools: [
      createWorkstreamTool(deps.service),
      activateWorkstreamTool(deps.service),
      ...createAgentHistoryTools(deps.service),
      ...createWorkstreamDiscoveryTools(deps.service),
    ],
  };
}

function createWorkstreamTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "git_context_create_workstream",
    description: "Create durable context for distinct multi-turn work and bind this run to its initial request.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short durable workstream title." },
        objective: { type: "string", description: "Stable objective or subject this workstream carries across runs." },
        reason: { type: "string", description: "Why existing workstreams do not own this request." },
        resources: {
          type: "array",
          maxItems: 32,
          items: resourceBindingSchema(),
          description: "Existing resource ids that belong to the new workstream. Omit to receive a managed output directory.",
        },
      },
      required: ["title", "objective", "reason"],
      additionalProperties: false,
    },
    outputSchema: routingOutputSchema(),
    annotations: routingAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "workstream", "create", "routing"],
      aliases: ["create workstream", "start durable work"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseCreateInput(input, context);
      if ("ok" in parsed) return parsed;
      try {
        const current = await currentRun(service, parsed.streamId, context);
        const selected = await service.createWorkstreamForRun({
          requestId: toolRequestId(context, "create-workstream"),
          runId: current.runId,
          title: parsed.title,
          objective: parsed.objective,
          ...(parsed.resources.length > 0 ? { resources: parsed.resources } : {}),
          at: current.startedAt,
        });
        return await routingSuccess(service, parsed.streamId, selected, "created");
      } catch (error) {
        return routingError(errorMessage(error));
      }
    },
  };
}

function activateWorkstreamTool(service: ContextEngineService): ToolDefinition {
  return {
    name: "git_context_activate_workstream",
    description: "Bind this run to an existing workstream and explicitly continue or create its active request.",
    inputSchema: {
      type: "object",
      properties: {
        workstreamId: {
          type: "string",
          pattern: "^W-[0-9]{8}-[0-9]{4}$",
          description: "Exact workstream id returned by discovery.",
        },
        reason: { type: "string", description: "Why this workstream and its resources own the current request." },
        requestDecision: {
          type: "object",
          properties: {
            kind: { enum: ["continue", "create"] },
            requestId: { type: "string", pattern: "^R-[0-9]{4}$" },
            title: { type: "string" },
            request: { type: "string" },
            acceptance: { type: "array", items: { type: "string" } },
            constraints: { type: "array", items: { type: "string" } },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["workstreamId", "reason", "requestDecision"],
      additionalProperties: false,
    },
    outputSchema: routingOutputSchema(),
    annotations: routingAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "workstream", "activate", "continue", "routing"],
      aliases: ["activate workstream", "continue durable work"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseActivateInput(input, context);
      if ("ok" in parsed) return parsed;
      try {
        const current = await currentRun(service, parsed.streamId, context);
        const selected = await service.activateWorkstreamForRun({
          requestId: toolRequestId(context, "activate-workstream"),
          runId: current.runId,
          workstreamId: parsed.workstreamId,
          route: parsed.route,
          at: current.startedAt,
        });
        return await routingSuccess(service, parsed.streamId, selected, "activated");
      } catch (error) {
        return routingError(errorMessage(error));
      }
    },
  };
}

async function currentRun(
  service: ContextEngineService,
  streamId: string,
  context?: ToolExecutionContext,
): Promise<{ runId: string; startedAt: string }> {
  const active = await service.getAgentContext({ streamId });
  const run = active.run?.run;
  if (!run || run.runId !== context?.runId) {
    throw new Error("Workstream routing requires the current prepared run.");
  }
  return { runId: run.runId, startedAt: run.startedAt };
}

async function routingSuccess(
  service: ContextEngineService,
  streamId: string,
  selected: SelectedWorkstreamForRunResponse,
  mode: "created" | "activated",
): Promise<ToolResult> {
  const active = await service.getAgentContext({ streamId });
  const workstream = active.activeWorkstream;
  if (!workstream) return routingError("Selected workstream context is unavailable after binding.");
  return okJsonResult({
    code: mode === "created"
      ? "GIT_CONTEXT_WORKSTREAM_CREATED"
      : "GIT_CONTEXT_WORKSTREAM_ACTIVATED",
    message: mode === "created" ? "Workstream created and selected." : "Workstream selected.",
    structuredContent: {
      status: "ready",
      streamId,
      workstreamId: selected.workstream.workstreamId,
      branch: selected.workstream.branch,
      mode,
      runId: selected.run.runId,
      workstreamHead: selected.workstream.head,
      workstreamCreated: selected.workstreamCreated,
      requestDecision: selected.workstreamRequestDecision,
      requestId: selected.run.workstreamBinding?.requestId,
      requestStatus: selected.context.currentRequest?.status,
      requestCreated: selected.workstreamRequestCreated,
      headBeforeSelection: selected.headBeforeSelection,
      resources: selected.resourceBindings,
      harnessContext: { contextEngine: buildContextEngineProjection(active) },
    },
  });
}

function resourceBindingSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      resourceId: { type: "string", pattern: "^RES-[0-9A-F]{24}$" },
      role: {
        enum: ["input", "reference", "primary", "supporting", "output", "deliverable", "evidence", "asset"],
      },
      access: { enum: ["read", "mutate"] },
      primary: { type: "boolean" },
    },
    required: ["resourceId", "role", "access"],
    additionalProperties: false,
  };
}

function routingOutputSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      status: { const: "ready" },
      streamId: { type: "string" },
      workstreamId: { type: "string" },
      branch: { type: "string" },
      mode: { enum: ["created", "activated"] },
      runId: { type: "string" },
      workstreamHead: { type: "string" },
      workstreamCreated: { type: "boolean" },
      requestDecision: { enum: ["initial", "continue", "create"] },
      requestId: { type: "string" },
      requestStatus: { enum: ["queued", "active", "blocked", "done", "dropped"] },
      requestCreated: { type: "boolean" },
      headBeforeSelection: { type: "string" },
      resources: { type: "array", items: { type: "object" } },
      harnessContext: { type: "object" },
    },
    required: [
      "status", "streamId", "workstreamId", "branch", "mode", "runId",
      "workstreamHead", "workstreamCreated", "requestDecision", "requestCreated",
      "headBeforeSelection", "resources", "harnessContext",
    ],
    additionalProperties: false,
  };
}

function routingAnnotations() {
  return commonAnnotations({ domain: "git_context", readOnly: false, idempotent: false, retrySafe: false });
}

function parseCreateInput(input: unknown, context?: ToolExecutionContext): {
  streamId: string;
  title: string;
  objective: string;
  resources: Array<{ resourceId: string; role: ResourceRole; access: "read" | "mutate"; primary?: boolean }>;
} | ToolResult {
  const record = objectInput(input);
  const streamId = context?.sessionId?.trim();
  const title = stringField(record, "title");
  const objective = stringField(record, "objective");
  const reason = stringField(record, "reason");
  const resources = resourceBindings(record["resources"]);
  if (!streamId || !title || !objective || !reason || resources === undefined) {
    return routingError("agent stream, title, objective, reason, and valid resource bindings are required.");
  }
  return { streamId, title, objective, resources };
}

function parseActivateInput(input: unknown, context?: ToolExecutionContext): {
  streamId: string;
  workstreamId: string;
  route: WorkstreamRequestRoute;
} | ToolResult {
  const record = objectInput(input);
  const streamId = context?.sessionId?.trim();
  const workstreamId = stringField(record, "workstreamId");
  const reason = stringField(record, "reason");
  if (!streamId || !workstreamId || !/^W-\d{8}-\d{4}$/.test(workstreamId) || !reason) {
    return routingError("An agent stream, valid W-* workstreamId, and reason are required.");
  }
  const route = parseRequestDecision(record["requestDecision"], reason);
  if (!route) return routingError("Activation requires a complete continue-or-create request decision.");
  return { streamId, workstreamId, route };
}

function parseRequestDecision(value: unknown, reason: string): WorkstreamRequestRoute | undefined {
  const record = objectInput(value);
  if (record["kind"] === "continue") {
    const requestId = stringField(record, "requestId");
    return requestId && /^R-\d{4}$/.test(requestId)
      ? { kind: "continue_active_request", requestId, reason }
      : undefined;
  }
  if (record["kind"] === "create") {
    const title = stringField(record, "title");
    const request = stringField(record, "request");
    const acceptance = stringArray(record["acceptance"]);
    const constraints = stringArray(record["constraints"]);
    return title && request && acceptance.length > 0
      ? { kind: "create_active_request", title, request, acceptance, constraints, reason }
      : undefined;
  }
  return undefined;
}

function resourceBindings(value: unknown): Array<{
  resourceId: string;
  role: ResourceRole;
  access: "read" | "mutate";
  primary?: boolean;
}> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const result: Array<{ resourceId: string; role: ResourceRole; access: "read" | "mutate"; primary?: boolean }> = [];
  for (const entry of value) {
    const record = objectInput(entry);
    const resourceId = stringField(record, "resourceId");
    const role = stringField(record, "role") as ResourceRole | undefined;
    const access = stringField(record, "access");
    if (!resourceId || !/^RES-[0-9A-F]{24}$/.test(resourceId) || !isResourceRole(role)
      || (access !== "read" && access !== "mutate")
      || (record["primary"] !== undefined && typeof record["primary"] !== "boolean")) {
      return undefined;
    }
    result.push({ resourceId, role, access, ...(record["primary"] === true ? { primary: true } : {}) });
  }
  return result;
}

function isResourceRole(value: string | undefined): value is ResourceRole {
  return value === "input" || value === "reference" || value === "primary"
    || value === "supporting" || value === "output" || value === "deliverable"
    || value === "evidence" || value === "asset";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function routingError(message: string): ToolResult {
  return errorResult({
    code: "GIT_CONTEXT_WORKSTREAM_ROUTING_FAILED",
    message,
    category: "conflict",
    retryable: false,
    suggestedNextActions: ["Correct the workstream/resource identity or ask one focused ownership question."],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toolRequestId(context: ToolExecutionContext | undefined, operation: string): string {
  const runId = context?.runId?.trim();
  const callId = context?.callId?.trim();
  if (!runId || !callId) throw new Error("Context Engine routing requires run and tool-call identity.");
  return runId + ":" + callId + ":" + operation;
}
