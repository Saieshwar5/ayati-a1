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

export function createGitContextSkill(deps: GitContextSkillDeps): SkillDefinition {
  return {
    id: "git-context",
    version: "5.0.0",
    description: "Inspect agent-stream history and discover, create, or continue durable workstreams linked to real resources.",
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
    description:
      "Bind this run to an existing workstream using one explicit request lifecycle operation. "
      + "Any added or removed independently acceptable scope belongs in a new request.",
    inputSchema: {
      type: "object",
      properties: {
        workstreamId: {
          type: "string",
          pattern: "^W-[0-9]{8}-[0-9]{4}$",
          description: "Exact workstream id returned by discovery.",
        },
        reason: {
          type: "string",
          description:
            "Why this workstream owns the request and why the selected request decision matches the user's intent.",
        },
        requestDecision: {
          type: "object",
          description:
            "Continue the unchanged active contract, amend a clarification, activate or resume "
            + "observed work, create a separate request, or atomically defer and switch.",
          properties: {
            kind: {
              enum: [
                "continue_current",
                "activate_existing",
                "resume_blocked",
                "amend_current",
                "create_and_activate",
                "create_queued",
                "defer_current_and_activate_existing",
                "defer_current_and_create",
              ],
              description:
                "The exact lifecycle operation authorized by the user and current durable state; "
                + "continue_current never changes the request contract.",
            },
            requestId: {
              type: "string",
              pattern: "^R-[0-9]{4}$",
              description: "Exact request for continue, activate, or resume.",
            },
            currentRequestId: {
              type: "string",
              pattern: "^R-[0-9]{4}$",
              description: "Exact active request that amendment or deferral will update.",
            },
            nextRequestId: {
              type: "string",
              pattern: "^R-[0-9]{4}$",
              description: "Exact queued request to activate after deferring the current request.",
            },
            title: {
              type: "string",
              description: "Title for a newly created request.",
            },
            request: {
              type: "string",
              description: "Contract body for the new immutable request identity.",
            },
            acceptance: {
              type: "array",
              items: { type: "string" },
              description: "Acceptance criteria for a newly created request.",
            },
            constraints: {
              type: "array",
              items: { type: "string" },
              description: "Constraints for a newly created request.",
            },
            authority: {
              enum: ["user", "trusted_policy"],
            },
            patch: {
              type: "object",
              properties: {
                title: { type: "string" },
                request: { type: "string" },
                acceptance: { type: "array", items: { type: "string" } },
                constraints: { type: "array", items: { type: "string" } },
              },
              additionalProperties: false,
            },
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
      requestStatus: (selected.context.selectedRequest ?? selected.context.currentRequest)?.status,
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
      requestDecision: {
        enum: [
          "initial",
          "continue_current",
          "activate_existing",
          "resume_blocked",
          "amend_current",
          "create_and_activate",
          "create_queued",
          "defer_current_and_activate_existing",
          "defer_current_and_create",
        ],
      },
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
  if (!route) {
    return routingError("Activation requires one complete, valid request lifecycle decision.");
  }
  return { streamId, workstreamId, route };
}

function parseRequestDecision(value: unknown, reason: string): WorkstreamRequestRoute | undefined {
  const record = objectInput(value);
  if (record["kind"] === "continue_current"
    || record["kind"] === "activate_existing"
    || record["kind"] === "resume_blocked") {
    const requestId = stringField(record, "requestId");
    return requestId && /^R-\d{4}$/.test(requestId)
      ? { kind: record["kind"], requestId, reason }
      : undefined;
  }
  if (record["kind"] === "create_and_activate"
    || record["kind"] === "create_queued"
    || record["kind"] === "defer_current_and_create") {
    const title = stringField(record, "title");
    const request = stringField(record, "request");
    const acceptance = stringArray(record["acceptance"]);
    const constraints = stringArray(record["constraints"]);
    if (!title || !request || acceptance.length === 0) return undefined;
    if (record["kind"] !== "defer_current_and_create") {
      return {
        kind: record["kind"],
        title,
        request,
        acceptance,
        constraints,
        reason,
      };
    }
    const currentRequestId = stringField(record, "currentRequestId");
    return currentRequestId && /^R-\d{4}$/.test(currentRequestId)
      ? {
          kind: "defer_current_and_create",
          currentRequestId,
          title,
          request,
          acceptance,
          constraints,
          reason,
        }
      : undefined;
  }
  if (record["kind"] === "defer_current_and_activate_existing") {
    const currentRequestId = stringField(record, "currentRequestId");
    const nextRequestId = stringField(record, "nextRequestId");
    return currentRequestId && nextRequestId
      && /^R-\d{4}$/.test(currentRequestId)
      && /^R-\d{4}$/.test(nextRequestId)
      ? { kind: record["kind"], currentRequestId, nextRequestId, reason }
      : undefined;
  }
  if (record["kind"] === "amend_current") {
    const currentRequestId = stringField(record, "currentRequestId");
    const patch = requestPatch(record["patch"]);
    const authority = record["authority"];
    return currentRequestId && /^R-\d{4}$/.test(currentRequestId)
      && patch
      && (authority === "user" || authority === "trusted_policy")
      ? { kind: record["kind"], currentRequestId, patch, authority, reason }
      : undefined;
  }
  return undefined;
}

function requestPatch(value: unknown): {
  title?: string;
  request?: string;
  acceptance?: string[];
  constraints?: string[];
} | undefined {
  const record = objectInput(value);
  const keys = Object.keys(record);
  if (keys.length === 0
    || keys.some((key) => !["title", "request", "acceptance", "constraints"].includes(key))) {
    return undefined;
  }
  const title = record["title"] === undefined ? undefined : stringField(record, "title");
  const request = record["request"] === undefined ? undefined : stringField(record, "request");
  const acceptance = record["acceptance"] === undefined
    ? undefined
    : stringArray(record["acceptance"]);
  const constraints = record["constraints"] === undefined
    ? undefined
    : stringArray(record["constraints"]);
  if ((record["title"] !== undefined && !title)
    || (record["request"] !== undefined && !request)
    || (record["acceptance"] !== undefined && !acceptance?.length)) return undefined;
  return {
    ...(title ? { title } : {}),
    ...(request ? { request } : {}),
    ...(acceptance ? { acceptance } : {}),
    ...(constraints ? { constraints } : {}),
  };
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
