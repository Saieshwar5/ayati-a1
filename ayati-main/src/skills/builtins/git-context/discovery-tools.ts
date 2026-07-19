import type {
  GitContextService,
  ResourceKind,
  ResourceRole,
  WorkstreamDiscoveryView,
} from "ayati-git-context";
import type { ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";
import {
  commonAnnotations,
  errorResult,
  okJsonResult,
  succeededContract,
} from "../contract-helpers.js";

export function createWorkstreamDiscoveryTools(service: GitContextService): ToolDefinition[] {
  return [
    findWorkstreamsTool(service),
    readWorkstreamTool(service),
    setWorkstreamStarTool(service),
    findResourcesTool(service),
    inspectResourceTool(service),
    bindResourcesTool(service),
  ];
}

function findWorkstreamsTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_find_workstreams",
    description: "Search durable workstreams by identity, subject, request, resource path, unfinished state, star, recency, or frequency.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        paths: { type: "array", maxItems: 20, items: { type: "string" } },
        view: { enum: ["relevant", "unfinished", "starred", "recent", "frequent"] },
        includeArchived: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    outputSchema: listOutputSchema("workstreams"),
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "workstream", "find", "recent", "starred"],
      aliases: ["find workstream", "search durable work", "recent work"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const sessionId = context?.sessionId?.trim();
      if (!sessionId) return discoveryError("Workstream discovery requires the current session.");
      const query = optionalString(record, "query");
      const paths = stringArray(record["paths"]);
      const view = discoveryView(record["view"]);
      const limit = integer(record["limit"]);
      if (record["view"] !== undefined && !view) return discoveryError("Unknown workstream discovery view.");
      if (record["limit"] !== undefined && (!limit || limit < 1 || limit > 50)) {
        return discoveryError("Workstream discovery limit must be between 1 and 50.");
      }
      try {
        const result = await service.findWorkstreams({
          ...(query ? { query } : {}),
          ...(paths.length > 0 ? { paths } : {}),
          ...(view ? { view } : {}),
          ...(record["includeArchived"] === true ? { includeArchived: true } : {}),
          ...(limit ? { limit } : {}),
          sessionId,
        });
        return okJsonResult({
          code: "GIT_CONTEXT_WORKSTREAMS_FOUND",
          message: `Found ${result.workstreams.length} durable workstream candidate(s).`,
          structuredContent: { workstreams: result.workstreams, count: result.workstreams.length },
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function readWorkstreamTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_read_workstream",
    description: "Open committed workstream/request/resource context without binding the run.",
    inputSchema: {
      type: "object",
      properties: { workstreamId: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$" } },
      required: ["workstreamId"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { workstream: { type: "object" }, context: { type: "object" }, opened: { const: true } },
      required: ["workstream", "context", "opened"],
      additionalProperties: false,
    },
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "workstream", "read", "inspect"],
      aliases: ["open workstream", "inspect durable work"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const workstreamId = optionalString(objectInput(input), "workstreamId");
      const identity = executionIdentity(context);
      if (!workstreamId || !/^W-\d{8}-\d{4}$/.test(workstreamId) || !identity) {
        return discoveryError("Opening a workstream requires a valid id and current run identity.");
      }
      try {
        const result = await service.readWorkstream({
          requestId: identity.requestId + ":open-workstream",
          sessionId: identity.sessionId,
          runId: identity.runId,
          workstreamId,
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_WORKSTREAM_OPENED",
          message: `Opened ${result.workstream.title} without binding the run.`,
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function setWorkstreamStarTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_set_workstream_star",
    description: "Star or unstar a workstream only on the user's explicit instruction.",
    inputSchema: {
      type: "object",
      properties: {
        workstreamId: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$" },
        starred: { type: "boolean" },
        reason: { type: "string" },
      },
      required: ["workstreamId", "starred", "reason"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { workstreamId: { type: "string" }, starred: { type: "boolean" }, starredAt: { type: "string" } },
      required: ["workstreamId", "starred"],
      additionalProperties: false,
    },
    annotations: controlAnnotations(true),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "workstream", "preference", "star"],
      aliases: ["star workstream", "favorite work"],
      domain: "git_context",
      priority: 8,
    },
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const workstreamId = optionalString(record, "workstreamId");
      const reason = optionalString(record, "reason");
      const identity = executionIdentity(context);
      if (!workstreamId || !/^W-\d{8}-\d{4}$/.test(workstreamId)
        || typeof record["starred"] !== "boolean" || !reason || !identity) {
        return discoveryError("A valid workstream id, star value, reason, and current run are required.");
      }
      try {
        const active = await service.getActiveContext({ sessionId: identity.sessionId });
        const run = active.run?.run;
        if (!run || run.runId !== identity.runId) return discoveryError("Star changes require the current run.");
        const userText = active.session?.pendingConversationContext
          .flatMap((conversation) => conversation.messages)
          .filter((message) => message.role === "user")
          .at(-1)?.content ?? "";
        if (!hasExplicitStarInstruction(userText, record["starred"])) {
          return discoveryError("Stars require an explicit star or unstar instruction in this turn.");
        }
        const result = await service.setWorkstreamStar({
          requestId: identity.requestId + ":set-star",
          sessionId: identity.sessionId,
          runId: identity.runId,
          workstreamId,
          starred: record["starred"],
          at: run.startedAt,
        });
        return okJsonResult({
          code: result.starred ? "GIT_CONTEXT_WORKSTREAM_STARRED" : "GIT_CONTEXT_WORKSTREAM_UNSTARRED",
          message: result.starred ? "Workstream starred." : "Workstream unstarred.",
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function findResourcesTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_find_resources",
    description: "Find files, directories, URLs, media, datasets, databases, repositories, or external objects and their owning workstreams.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        resourceIds: { type: "array", maxItems: 32, items: { type: "string" } },
        locators: { type: "array", maxItems: 32, items: { type: "string" } },
        workstreamId: { type: "string", pattern: "^W-[0-9]{8}-[0-9]{4}$" },
        includeMissing: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    outputSchema: listOutputSchema("resources"),
    annotations: readAnnotations(),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "resource", "find", "ownership"],
      aliases: ["find resource", "who owns this file", "search artifacts"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input): Promise<ToolResult> {
      const record = objectInput(input);
      const limit = integer(record["limit"]);
      try {
        const result = await service.findResources({
          ...(optionalString(record, "query") ? { query: optionalString(record, "query") } : {}),
          ...(stringArray(record["resourceIds"]).length > 0 ? { resourceIds: stringArray(record["resourceIds"]) } : {}),
          ...(stringArray(record["locators"]).length > 0 ? { locators: stringArray(record["locators"]) } : {}),
          ...(optionalString(record, "workstreamId") ? { workstreamId: optionalString(record, "workstreamId") } : {}),
          ...(record["includeMissing"] === true ? { includeMissing: true } : {}),
          ...(limit ? { limit } : {}),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_RESOURCES_FOUND",
          message: `Found ${result.resources.length} resource(s).`,
          structuredContent: { resources: result.resources, count: result.resources.length },
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function inspectResourceTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_inspect_resource",
    description: "Before workstream binding, register or refresh a user-provided filesystem path, URL, or external object in Ayati's durable resource catalog so it can identify and bind the correct workstream.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        url: { type: "string" },
        provider: { type: "string" },
        externalId: { type: "string" },
        uri: { type: "string" },
        kind: { enum: ["file", "directory", "document", "image", "audio", "video", "dataset", "database", "git_repository", "url", "external_object"] },
        displayName: { type: "string" },
        description: { type: "string" },
        aliases: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    annotations: controlAnnotations(true),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "resource", "inspect", "register"],
      aliases: [
        "inspect path",
        "register resource",
        "inspect url",
        "register existing directory",
        "adopt existing project path",
        "catalog user provided path",
      ],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const record = objectInput(input);
      const identity = executionIdentity(context);
      const locator = resourceLocator(record);
      if (!identity || !locator) return discoveryError("Exactly one valid path, URL, or external identity is required.");
      try {
        const result = await service.inspectResourceForRun({
          requestId: identity.requestId + ":inspect-resource",
          sessionId: identity.sessionId,
          runId: identity.runId,
          locator,
          ...(resourceKind(record["kind"]) ? { kind: resourceKind(record["kind"]) } : {}),
          origin: "user_reference",
          ...(optionalString(record, "displayName") ? { displayName: optionalString(record, "displayName") } : {}),
          ...(optionalString(record, "description") ? { description: optionalString(record, "description") } : {}),
          ...(stringArray(record["aliases"]).length > 0 ? { aliases: stringArray(record["aliases"]) } : {}),
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_RESOURCE_INSPECTED",
          message: result.existing ? "Resource metadata refreshed." : "Resource registered.",
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function bindResourcesTool(service: GitContextService): ToolDefinition {
  return {
    name: "git_context_bind_resources",
    description: "Link exact resources to the already selected workstream/request with read or mutate access.",
    inputSchema: {
      type: "object",
      properties: {
        bindings: {
          type: "array",
          minItems: 1,
          maxItems: 32,
          items: {
            type: "object",
            properties: {
              resourceId: { type: "string", pattern: "^RES-[0-9A-F]{24}$" },
              role: { enum: ["input", "reference", "primary", "supporting", "output", "deliverable", "evidence", "asset"] },
              access: { enum: ["read", "mutate"] },
              primary: { type: "boolean" },
            },
            required: ["resourceId", "role", "access"],
            additionalProperties: false,
          },
        },
      },
      required: ["bindings"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    annotations: controlAnnotations(false),
    resultContract: succeededContract(),
    selectionHints: {
      tags: ["git-context", "resource", "bind", "workstream"],
      aliases: ["bind resource", "add path to workstream"],
      domain: "git_context",
      priority: 10,
    },
    async execute(input, context): Promise<ToolResult> {
      const identity = executionIdentity(context);
      const bindings = parseBindings(objectInput(input)["bindings"]);
      if (!identity || !bindings) return discoveryError("Valid resource bindings and current run identity are required.");
      try {
        const active = await service.getActiveContext({ sessionId: identity.sessionId });
        const binding = active.run?.run.runId === identity.runId
          ? active.run.run.workstreamBinding
          : undefined;
        if (!binding) return discoveryError("Bind resources only after selecting a workstream for this run.");
        const result = await service.bindResourcesForRun({
          requestId: identity.requestId + ":bind-resources",
          sessionId: identity.sessionId,
          runId: identity.runId,
          workstreamId: binding.workstreamId,
          bindings,
          at: new Date().toISOString(),
        });
        return okJsonResult({
          code: "GIT_CONTEXT_RESOURCES_BOUND",
          message: `Bound ${bindings.length} resource(s) to the active workstream.`,
          structuredContent: result,
        });
      } catch (error) {
        return discoveryError(errorMessage(error));
      }
    },
  };
}

function hasExplicitStarInstruction(text: string, starred: boolean): boolean {
  const normalized = text.toLowerCase();
  return starred
    ? /\b(?:star|favorite|favourite)\b/.test(normalized)
      && !/\b(?:unstar|unfavorite|unfavourite|remove (?:the )?star)\b/.test(normalized)
    : /\b(?:unstar|unfavorite|unfavourite|remove (?:the )?star)\b/.test(normalized);
}

function resourceLocator(record: Record<string, unknown>):
  | { kind: "filesystem"; path: string }
  | { kind: "url"; url: string }
  | { kind: "external"; provider: string; externalId: string; uri?: string }
  | undefined {
  const path = optionalString(record, "path");
  const url = optionalString(record, "url");
  const provider = optionalString(record, "provider");
  const externalId = optionalString(record, "externalId");
  const choices = Number(Boolean(path)) + Number(Boolean(url)) + Number(Boolean(provider && externalId));
  if (choices !== 1) return undefined;
  if (path) return { kind: "filesystem", path };
  if (url) return { kind: "url", url };
  return provider && externalId
    ? { kind: "external", provider, externalId, ...(optionalString(record, "uri") ? { uri: optionalString(record, "uri") } : {}) }
    : undefined;
}

function parseBindings(value: unknown): Array<{
  resourceId: string;
  role: ResourceRole;
  access: "read" | "mutate";
  primary?: boolean;
}> | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const result: Array<{ resourceId: string; role: ResourceRole; access: "read" | "mutate"; primary?: boolean }> = [];
  for (const entry of value) {
    const record = objectInput(entry);
    const resourceId = optionalString(record, "resourceId");
    const role = optionalString(record, "role") as ResourceRole | undefined;
    const access = optionalString(record, "access");
    if (!resourceId || !/^RES-[0-9A-F]{24}$/.test(resourceId) || !resourceRole(role)
      || (access !== "read" && access !== "mutate")) return undefined;
    result.push({ resourceId, role, access, ...(record["primary"] === true ? { primary: true } : {}) });
  }
  return result;
}

function resourceRole(value: string | undefined): value is ResourceRole {
  return value === "input" || value === "reference" || value === "primary"
    || value === "supporting" || value === "output" || value === "deliverable"
    || value === "evidence" || value === "asset";
}

function resourceKind(value: unknown): ResourceKind | undefined {
  return typeof value === "string" && [
    "file", "directory", "document", "image", "audio", "video", "dataset",
    "database", "git_repository", "url", "external_object",
  ].includes(value) ? value as ResourceKind : undefined;
}

function listOutputSchema(field: string): Record<string, unknown> {
  return {
    type: "object",
    properties: { [field]: { type: "array", items: { type: "object" } }, count: { type: "integer" } },
    required: [field, "count"],
    additionalProperties: false,
  };
}

function readAnnotations() {
  return commonAnnotations({ domain: "git_context", readOnly: true, idempotent: true, retrySafe: true });
}

function controlAnnotations(idempotent: boolean) {
  return commonAnnotations({ domain: "git_context", readOnly: false, idempotent, retrySafe: idempotent });
}

function executionIdentity(context?: ToolExecutionContext): {
  sessionId: string;
  runId: string;
  requestId: string;
} | undefined {
  const sessionId = context?.sessionId?.trim();
  const runId = context?.runId?.trim();
  const callId = context?.callId?.trim();
  return sessionId && runId && callId ? { sessionId, runId, requestId: runId + ":" + callId } : undefined;
}

function discoveryView(value: unknown): WorkstreamDiscoveryView | undefined {
  return value === "relevant" || value === "unfinished" || value === "starred"
    || value === "recent" || value === "frequent" ? value : undefined;
}

function objectInput(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function discoveryError(message: string): ToolResult {
  return errorResult({
    code: "GIT_CONTEXT_DISCOVERY_FAILED",
    message,
    category: "conflict",
    retryable: false,
    suggestedNextActions: ["Refine the workstream/resource search or ask one focused ownership question."],
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
