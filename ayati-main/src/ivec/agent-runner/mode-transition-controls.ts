import type { LlmToolSchema } from "../../core/contracts/llm-protocol.js";
import {
  workstreamActivateProposalSchema,
  workstreamCreateProposalSchema,
} from "../workstream-binding/proposal.js";
import { workstreamWorkspaceTargetArraySchema } from "../workstream-binding/workspace-targets.js";
import type { ModeCapabilityOptions } from "./capabilities/contracts.js";
import { normalizeModeTransitionRequest } from "./mode-transition-request.js";
import {
  resourceMetadataArraySchema,
  validationOutcomeRefArraySchema,
} from "./task-validation-control-schema.js";
import type {
  ModeTransitionMutationScope,
  ModeTransitionReference,
  ModeTransitionRequest,
  VirtualModeTransitionTarget,
} from "./virtual-mode.js";

export const MODE_TRANSITION_CONTROL_TOOL_NAMES = [
  "decision_enter_context_retrieve",
  "decision_enter_observe_locate",
  "decision_enter_observe_investigate",
  "decision_enter_workstream_route",
  "decision_resolve_activate",
  "decision_resolve_create",
  "decision_enter_execute",
  "decision_enter_validation",
] as const;

export type ModeTransitionControlToolName =
  typeof MODE_TRANSITION_CONTROL_TOOL_NAMES[number];

const MODE_TRANSITION_CONTROL_TOOL_NAME_SET = new Set<string>(
  MODE_TRANSITION_CONTROL_TOOL_NAMES,
);

const PURPOSE_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 500,
  description: "One concise sentence describing the immediate responsibility.",
} as const;

const WORKING_NOTES_SCHEMA = {
  type: "array",
  items: { type: "string" },
  maxItems: 5,
} as const;

export function isModeTransitionControlToolName(
  name: string,
): name is ModeTransitionControlToolName {
  return MODE_TRANSITION_CONTROL_TOOL_NAME_SET.has(name);
}

export function buildModeTransitionControlTools(
  capabilities: ModeCapabilityOptions,
  allowedDestinations: VirtualModeTransitionTarget[],
): LlmToolSchema[] {
  const allowed = new Set(allowedDestinations);
  const tools: LlmToolSchema[] = [];

  if (allowed.has("context.retrieve")) {
    tools.push(controlTool(
      "decision_enter_context_retrieve",
      "Temporarily enter read-only context.retrieve to load one or more advertised Hot Context entries.",
      commonProperties(capabilities["context.retrieve"]),
      ["purpose", "capabilities"],
    ));
  }
  if (allowed.has("observe.locate")) {
    tools.push(controlTool(
      "decision_enter_observe_locate",
      "Enter read-only observe.locate to search for an uncertain file, resource, workstream, or other target.",
      {
        ...commonProperties(capabilities["observe.locate"]),
        subjects: subjectArraySchema(),
      },
      ["purpose", "capabilities"],
    ));
  }
  if (allowed.has("observe.investigate")) {
    tools.push(controlTool(
      "decision_enter_observe_investigate",
      "Enter read-only observe.investigate to inspect exact known targets or use a targetless system observation capability. References are required for target-backed capabilities and omitted for system:time or system:health.",
      {
        ...commonProperties(capabilities["observe.investigate"]),
        references: referenceArraySchema(),
      },
      ["purpose", "capabilities"],
    ));
  }
  if (allowed.has("workstream.route")) {
    tools.push(controlTool(
      "decision_enter_workstream_route",
      "Enter the control-only workstream routing stage after successful current-run workstream or resource observation. This stage loads no action tools; it selects the binding through one resolve control or returns to observation for missing evidence.",
      controlOnlyProperties(),
      ["purpose"],
    ));
  }
  if (allowed.has("resolve")) {
    const activateProperties = {
      ...commonProperties(capabilities.resolve),
    };
    const createProperties = {
      ...commonProperties(capabilities.resolve),
      workspaceTargets: workstreamWorkspaceTargetArraySchema(),
    };
    tools.push(
      controlTool(
        "decision_resolve_activate",
        "Activate one exact observed workstream and request using existing resource IDs returned by current-run routing. The runtime derives paths, mutation scope, repository HEAD, and evidence.",
        {
          ...activateProperties,
          binding: workstreamActivateProposalSchema(),
        },
        ["purpose", "capabilities", "binding"],
      ),
      controlTool(
        "decision_resolve_create",
        "Create one new workstream and initial request for exact file or directory targets relative to context.run.workspaceRoot. The runtime derives absolute paths, routing evidence, and resource identities.",
        {
          ...createProperties,
          binding: workstreamCreateProposalSchema(),
        },
        ["purpose", "capabilities", "workspaceTargets", "binding"],
      ),
    );
  }
  if (allowed.has("execute")) {
    tools.push(controlTool(
      "decision_enter_execute",
      "Enter bound execute with an exact mutation-capable responsibility and authoritative mutation scopes.",
      {
        ...commonProperties(capabilities.execute),
        references: referenceArraySchema(),
        mutationScopes: mutationScopeArraySchema(),
      },
      ["purpose", "capabilities", "mutationScopes"],
    ));
  }
  if (allowed.has("validation")) {
    tools.push(controlTool(
      "decision_enter_validation",
      "Evaluate only the important verified current-run outcomes required before reporting task completion. This proof-only mode runs no action tools.",
      {
        ...commonProperties(capabilities.validation),
        outcomeRefs: validationOutcomeRefArraySchema(),
        resourceMetadata: resourceMetadataArraySchema(),
      },
      ["purpose", "capabilities", "outcomeRefs"],
    ));
  }

  return tools;
}

export function modeTransitionControlNames(
  allowedDestinations: VirtualModeTransitionTarget[],
): ModeTransitionControlToolName[] {
  return buildModeTransitionControlTools(
    emptyCapabilityOptions(),
    allowedDestinations,
  ).map((tool) => tool.name as ModeTransitionControlToolName);
}

export function modeTransitionRequestFromControlCall(
  toolName: ModeTransitionControlToolName,
  input: Record<string, unknown>,
): ModeTransitionRequest {
  const binding = toolName === "decision_resolve_create"
    ? createBindingFromControlInput(input["binding"])
    : toolName === "decision_resolve_activate"
      ? activateBindingFromControlInput(input["binding"])
      : input["binding"];
  return normalizeModeTransitionRequest({
    ...input,
    to: modeTransitionTargetForControl(toolName),
    binding,
    references: normalizeControlReferences(input["references"]),
    mutationScopes: normalizeControlMutationScopes(input["mutationScopes"]),
  });
}

export function modeTransitionControlCallFromRequest(
  request: ModeTransitionRequest,
): {
  name: ModeTransitionControlToolName;
  input: Record<string, unknown>;
} {
  if (request.to === "workstream.route") {
    return {
      name: "decision_enter_workstream_route",
      input: {
        purpose: request.purpose,
      },
    };
  }
  const {
    to: _to,
    references,
    mutationScopes,
    workspaceTargets,
    validationChecks: _validationChecks,
    targets: _targets,
    binding,
    ...rest
  } = request;
  const compatibilityTargets = request.targets ?? [];
  const effectiveReferences = references
    ?? (
      request.to === "observe.investigate"
        ? compatibilityTargets.map(filesystemReference)
        : undefined
    );
  const effectiveMutationScopes = mutationScopes
    ?? (
      request.to === "execute"
        ? compatibilityTargets.map(filesystemMutationScope)
        : undefined
    );
  const effectiveSubjects = request.subjects
    ?? (
      request.to === "observe.locate"
      && compatibilityTargets.length > 0
        ? compatibilityTargets
        : undefined
    );
  return {
    name: modeTransitionControlNameForRequest(request),
    input: {
      ...rest,
      ...(binding
        ? {
            binding: binding.kind === "create"
              ? createBindingToControlInput(binding)
              : activateBindingToControlInput(binding),
          }
        : {}),
      ...(effectiveSubjects ? { subjects: effectiveSubjects } : {}),
      ...(effectiveReferences
        ? { references: effectiveReferences.map(toControlReference) }
        : {}),
      ...(effectiveMutationScopes
        ? { mutationScopes: effectiveMutationScopes.map(toControlMutationScope) }
        : {}),
      ...(workspaceTargets ? { workspaceTargets } : {}),
    },
  };
}

function modeTransitionControlNameForRequest(
  request: ModeTransitionRequest,
): ModeTransitionControlToolName {
  switch (request.to) {
    case "context.retrieve":
      return "decision_enter_context_retrieve";
    case "observe.locate":
      return "decision_enter_observe_locate";
    case "observe.investigate":
      return "decision_enter_observe_investigate";
    case "workstream.route":
      return "decision_enter_workstream_route";
    case "resolve":
      return request.binding?.kind === "activate"
        ? "decision_resolve_activate"
        : "decision_resolve_create";
    case "execute":
      return "decision_enter_execute";
    case "validation":
      return "decision_enter_validation";
  }
}

function modeTransitionTargetForControl(
  toolName: ModeTransitionControlToolName,
): VirtualModeTransitionTarget {
  switch (toolName) {
    case "decision_enter_context_retrieve":
      return "context.retrieve";
    case "decision_enter_observe_locate":
      return "observe.locate";
    case "decision_enter_observe_investigate":
      return "observe.investigate";
    case "decision_enter_workstream_route":
      return "workstream.route";
    case "decision_resolve_activate":
    case "decision_resolve_create":
      return "resolve";
    case "decision_enter_execute":
      return "execute";
    case "decision_enter_validation":
      return "validation";
  }
}

function commonProperties(capabilities: string[]): Record<string, unknown> {
  return {
    purpose: PURPOSE_SCHEMA,
    capabilities: capabilitySchema(capabilities),
    workingNotes: WORKING_NOTES_SCHEMA,
  };
}

function controlOnlyProperties(): Record<string, unknown> {
  return {
    purpose: PURPOSE_SCHEMA,
    workingNotes: WORKING_NOTES_SCHEMA,
  };
}

function capabilitySchema(capabilities: string[]): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 3,
    uniqueItems: true,
    items: {
      type: "string",
      enum: [...capabilities],
    },
    description: "Choose one to three exact capability ids from this destination-specific catalog.",
  };
}

function subjectArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    maxItems: 12,
    items: { type: "string", minLength: 1, maxLength: 500 },
    description: "Human search subjects only. These values are not filesystem or mutation authority.",
  };
}

function referenceArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 12,
    description: "Exact read-only references. Filesystem values must be canonical absolute host paths.",
    items: objectSchema({
      kind: {
        type: "string",
        enum: ["filesystem", "resource", "workstream", "url"],
      },
      value: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Absolute path, exact resource/workstream id, or HTTP(S) URL selected by kind.",
      },
    }, ["kind", "value"]),
  };
}

function mutationScopeArraySchema(): Record<string, unknown> {
  return {
    type: "array",
    minItems: 1,
    maxItems: 8,
    description: "Exact destinations selected for this mutation. Filesystem values are canonical absolute roots; resource ids name an existing resource when identity matters.",
    items: objectSchema({
      kind: {
        type: "string",
        enum: ["filesystem", "resource"],
      },
      value: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "Canonical absolute destination root or exact existing resource id selected by kind.",
      },
    }, ["kind", "value"]),
  };
}

function controlTool(
  name: ModeTransitionControlToolName,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): LlmToolSchema {
  return {
    name,
    description,
    inputSchema: objectSchema(properties, required),
  };
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

function normalizeControlReferences(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isRecord(item) || typeof item["value"] !== "string") return item;
    switch (item["kind"]) {
      case "filesystem":
        return { kind: "filesystem", path: item["value"] };
      case "resource":
        return { kind: "resource", resourceId: item["value"] };
      case "workstream":
        return { kind: "workstream", workstreamId: item["value"] };
      case "url":
        return { kind: "url", url: item["value"] };
      default:
        return item;
    }
  });
}

function normalizeControlMutationScopes(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!isRecord(item) || typeof item["value"] !== "string") return item;
    if (item["kind"] === "filesystem") {
      return { kind: "filesystem", path: item["value"] };
    }
    if (item["kind"] === "resource") {
      return { kind: "resource", resourceId: item["value"] };
    }
    return item;
  });
}

function createBindingFromControlInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...value, kind: "create" };
}

function activateBindingFromControlInput(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return { ...value, kind: "activate" };
}

function createBindingToControlInput(
  binding: Extract<NonNullable<ModeTransitionRequest["binding"]>, { kind: "create" }>,
): Record<string, unknown> {
  return {
    title: binding.title,
    objective: binding.objective,
    initialRequest: binding.initialRequest,
  };
}

function activateBindingToControlInput(
  binding: Extract<NonNullable<ModeTransitionRequest["binding"]>, { kind: "activate" }>,
): Record<string, unknown> {
  return {
    workstreamId: binding.workstreamId,
    requestDecision: binding.requestDecision,
    resourceIds: binding.resourceIds,
  };
}

function toControlReference(reference: ModeTransitionReference): Record<string, string> {
  switch (reference.kind) {
    case "filesystem":
      return { kind: reference.kind, value: reference.path };
    case "resource":
      return { kind: reference.kind, value: reference.resourceId };
    case "workstream":
      return { kind: reference.kind, value: reference.workstreamId };
    case "url":
      return { kind: reference.kind, value: reference.url };
  }
}

function toControlMutationScope(
  scope: ModeTransitionMutationScope,
): Record<string, string> {
  return scope.kind === "filesystem"
    ? { kind: scope.kind, value: scope.path }
    : { kind: scope.kind, value: scope.resourceId };
}

function filesystemReference(path: string): ModeTransitionReference {
  return { kind: "filesystem", path };
}

function filesystemMutationScope(path: string): ModeTransitionMutationScope {
  return { kind: "filesystem", path };
}

function emptyCapabilityOptions(): ModeCapabilityOptions {
  return {
    "context.retrieve": [],
    "observe.locate": [],
    "observe.investigate": [],
    "workstream.route": [],
    resolve: [],
    execute: [],
    validation: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
