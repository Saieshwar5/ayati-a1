import type { VirtualModeTransitionTarget } from "../virtual-mode.js";

export type CapabilityId = string;

export interface CapabilityRecommendation {
  success?: CapabilityId[];
  failure?: CapabilityId[];
}

export interface CapabilityDefinition {
  id: CapabilityId;
  summary: string;
  whenToUse: string;
  allowedModes: VirtualModeTransitionTarget[];
  coreTools: string[];
  optionalTools?: string[];
  suggestedNext?: CapabilityRecommendation;
  authority?: "any" | "unbound" | "bound";
  targetRequirement?: "reference" | "none";
}

export interface CapabilityCard {
  id: CapabilityId;
  summary: string;
  whenToUse: string;
  allowedModes: VirtualModeTransitionTarget[];
}

export interface ModeCapabilityOptions {
  "context.retrieve": string[];
  "observe.locate": string[];
  "observe.investigate": string[];
  "workstream.route": string[];
  resolve: string[];
  execute: string[];
  validation: string[];
}

export type CapabilityUnavailableReason =
  | "mode_not_allowed"
  | "requires_workstream_binding"
  | "not_available_after_workstream_binding"
  | "routing_unavailable"
  | "core_tool_unavailable";

export interface UnavailableCapability {
  capability: string;
  reason: CapabilityUnavailableReason;
  tools: string[];
}

export type CapabilitySurfaceStatus =
  | "loaded"
  | "partial"
  | "already_active"
  | "unavailable"
  | "no_match"
  | "invalid_request"
  | "surface_too_large"
  | "failed"
  | "not_needed";

export interface CapabilitySurfaceResult {
  status: CapabilitySurfaceStatus;
  requested: string[];
  capabilities: string[];
  loaded: string[];
  alreadyActive: string[];
  evicted: string[];
  missing: string[];
  unavailable: Array<{
    tool: string;
    reason: Exclude<CapabilityUnavailableReason, "mode_not_allowed" | "core_tool_unavailable">;
  }>;
  unavailableCapabilities: UnavailableCapability[];
  omittedOptionalTools: string[];
  coverage: Array<{
    capability: string;
    coreTools: string[];
    optionalTools: string[];
    omittedOptionalTools: string[];
  }>;
  message: string;
}
