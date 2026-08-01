import type { ToolExecutionContext, ToolDefinition } from "../../../skills/types.js";
import type { ToolExecutor } from "../../../skills/tool-executor.js";
import type { LoopState } from "../../types.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
} from "../workstream-binding-capability-policy.js";
import type { VirtualModeTransitionTarget } from "../virtual-mode.js";
import { CapabilityCatalog } from "./catalog.js";
import type {
  CapabilitySurfaceResult,
  ModeCapabilityOptions,
} from "./contracts.js";
import { buildCapabilityPromptProjection } from "./prompt-projection.js";
import { ToolRegistry } from "./registry.js";
import {
  DEFAULT_MAX_CAPABILITY_SURFACE_TOOLS,
  resolveCapabilitySurface,
} from "./surface-resolver.js";

interface RunCapabilityState {
  capabilities: string[];
  tools: string[];
}

export interface CapabilitySurfaceManagerOptions {
  catalog?: CapabilityCatalog;
  registry: ToolRegistry;
  toolExecutor: ToolExecutor;
  maxVisibleTools?: number;
  validateCoverage?: boolean;
}

export class CapabilitySurfaceManager {
  readonly catalog: CapabilityCatalog;
  readonly registry: ToolRegistry;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxVisibleTools: number;
  private readonly runs = new Map<string, RunCapabilityState>();

  constructor(options: CapabilitySurfaceManagerOptions) {
    this.catalog = options.catalog ?? new CapabilityCatalog();
    this.registry = options.registry;
    this.toolExecutor = options.toolExecutor;
    this.maxVisibleTools = Math.min(
      DEFAULT_MAX_CAPABILITY_SURFACE_TOOLS,
      Math.max(1, Math.floor(options.maxVisibleTools ?? DEFAULT_MAX_CAPABILITY_SURFACE_TOOLS)),
    );
    if (options.validateCoverage !== false) {
      this.registry.assertCapabilityCoverage(this.catalog);
    }
  }

  getCapabilitySummary(state: LoopState, context: ToolExecutionContext): string {
    return buildCapabilityPromptProjection({
      state,
      catalog: this.catalog,
      registry: this.registry,
      activeCapabilities: this.getRunState(context).capabilities,
      modeCapabilityOptions: this.getModeCapabilityOptions(state),
    });
  }

  getModeCapabilityOptions(state: LoopState): ModeCapabilityOptions {
    const available = this.catalog.modeOptions(this.registry.nameSet());
    return {
      "context.retrieve": state.hotContext?.available.length
        ? this.filterAvailableCapabilities(
            available["context.retrieve"],
            "context.retrieve",
            state,
          )
        : [],
      "observe.locate": this.filterAvailableCapabilities(
        available["observe.locate"],
        "observe.locate",
        state,
      ),
      "observe.investigate": this.filterAvailableCapabilities(
        available["observe.investigate"],
        "observe.investigate",
        state,
      ),
      "workstream.route": this.filterAvailableCapabilities(
        available["workstream.route"],
        "workstream.route",
        state,
      ),
      resolve: this.filterAvailableCapabilities(available.resolve, "resolve", state),
      execute: this.filterAvailableCapabilities(available.execute, "execute", state),
      validation: this.filterAvailableCapabilities(available.validation, "validation", state),
    };
  }

  visibleToolDefinitions(context: ToolExecutionContext): ToolDefinition[] {
    return this.toolExecutor.definitions(context);
  }

  listActive(context: ToolExecutionContext): string[] {
    return [...this.getRunState(context).tools];
  }

  listActiveCapabilities(context: ToolExecutionContext): string[] {
    return [...this.getRunState(context).capabilities];
  }

  resetRun(context: ToolExecutionContext): void {
    const runId = readRunId(context);
    this.runs.delete(runId);
    this.toolExecutor.unmount?.(this.groupId(runId));
  }

  prepareForDecision(
    state: LoopState,
    context: ToolExecutionContext,
  ): CapabilitySurfaceResult {
    const runState = this.getRunState(context);
    if (runState.capabilities.length === 0) {
      this.syncMount(context);
      return emptySurfaceResult("not_needed", []);
    }

    const mode = state.virtualMode.active;
    if (!mode || mode === "context.maintain" || mode === "run.maintain") {
      const previousTools = [...runState.tools];
      runState.capabilities = [];
      runState.tools = [];
      this.syncMount(context);
      return {
        ...emptySurfaceResult("partial", []),
        evicted: previousTools,
        message: mode === "context.maintain" || mode === "run.maintain"
          ? "Cleared the capability surface while runtime context maintenance is active."
          : "Cleared the capability surface because no operational mode is active.",
      };
    }

    const resolved = this.resolveCapabilities({
      capabilities: runState.capabilities,
      mode,
      state,
    });
    if (
      resolved.status === "invalid_request"
      || resolved.status === "unavailable"
      || resolved.status === "no_match"
      || resolved.status === "surface_too_large"
      || resolved.status === "failed"
    ) {
      const previousTools = [...runState.tools];
      runState.capabilities = [];
      runState.tools = [];
      this.syncMount(context);
      return {
        ...resolved,
        evicted: previousTools,
        message: `${resolved.message} Cleared the previous capability surface.`,
      };
    }

    if (!equalStrings(runState.tools, resolved.loaded)) {
      const previousTools = [...runState.tools];
      runState.tools = [...resolved.loaded];
      this.syncMount(context);
      return {
        ...resolved,
        evicted: previousTools.filter((tool) => !runState.tools.includes(tool)),
        message: `${resolved.message} Refreshed the capability surface for current policy.`,
      };
    }

    this.syncMount(context);
    return emptySurfaceResult("not_needed", runState.capabilities);
  }

  resolveCapabilities(input: {
    capabilities: string[];
    mode: VirtualModeTransitionTarget;
    state: LoopState;
  }): CapabilitySurfaceResult {
    return resolveCapabilitySurface({
      catalog: this.catalog,
      registry: this.registry,
      capabilities: input.capabilities,
      mode: input.mode,
      policy: deriveWorkstreamBindingCapabilityPolicy(input.state),
      maxVisibleTools: this.maxVisibleTools,
      contextPressureActive: Boolean(
        input.state.contextPressure && input.state.contextPressure.mode !== "full",
      ),
    });
  }

  replaceWithCapabilities(input: {
    capabilities: string[];
    mode: VirtualModeTransitionTarget;
    state: LoopState;
    context: ToolExecutionContext;
  }): CapabilitySurfaceResult {
    const resolved = this.resolveCapabilities(input);
    if (
      resolved.status === "invalid_request"
      || resolved.status === "unavailable"
      || resolved.status === "no_match"
      || resolved.status === "surface_too_large"
      || resolved.status === "failed"
    ) {
      return resolved;
    }

    const runState = this.getRunState(input.context);
    const previousTools = [...runState.tools];
    const exactSame = equalStrings(runState.capabilities, resolved.capabilities)
      && equalStrings(runState.tools, resolved.loaded);
    if (exactSame) {
      return {
        ...resolved,
        status: "already_active",
        loaded: [],
        alreadyActive: [...runState.tools],
        message: `The ${resolved.capabilities.join(", ")} capability surface is already active.`,
      };
    }

    runState.capabilities = [...resolved.capabilities];
    runState.tools = [...resolved.loaded];
    this.syncMount(input.context);
    return {
      ...resolved,
      evicted: previousTools.filter((tool) => !runState.tools.includes(tool)),
      message: previousTools.length > 0
        ? `${resolved.message} Replaced the previous mode tool surface.`
        : resolved.message,
    };
  }

  private getRunState(context: ToolExecutionContext): RunCapabilityState {
    const runId = readRunId(context);
    const existing = this.runs.get(runId);
    if (existing) return existing;
    const created: RunCapabilityState = {
      capabilities: [],
      tools: [],
    };
    this.runs.set(runId, created);
    return created;
  }

  private filterAvailableCapabilities(
    capabilities: string[],
    mode: VirtualModeTransitionTarget,
    state: LoopState,
  ): string[] {
    return capabilities.filter((capability) => {
      const result = this.resolveCapabilities({
        capabilities: [capability],
        mode,
        state,
      });
      return result.status === "loaded" || result.status === "partial";
    });
  }

  private syncMount(context: ToolExecutionContext): void {
    const runId = readRunId(context);
    const state = this.getRunState(context);
    const tools = state.tools
      .map((name) => this.registry.get(name))
      .filter((tool): tool is ToolDefinition => tool !== undefined);
    this.toolExecutor.mount?.(this.groupId(runId), tools, {
      scope: "run",
      runId,
      sessionId: context.sessionId,
      activatedAtStep: context.stepNumber,
      skillId: "capability-surface",
      toolIds: state.tools,
      description: "Run-scoped capability tool surface.",
    });
  }

  private groupId(runId: string): string {
    return `dynamic:capability-surface:${runId}`;
  }
}

function emptySurfaceResult(
  status: CapabilitySurfaceResult["status"],
  capabilities: string[],
): CapabilitySurfaceResult {
  return {
    status,
    requested: [...capabilities],
    capabilities: [...capabilities],
    loaded: [],
    alreadyActive: [],
    evicted: [],
    missing: [],
    unavailable: [],
    unavailableCapabilities: [],
    omittedOptionalTools: [],
    coverage: [],
    message: status === "not_needed"
      ? "The active capability surface already matches the current authority state."
      : "Capability surface updated.",
  };
}

function readRunId(context: ToolExecutionContext): string {
  return context.runId ?? context.sessionId ?? context.clientId ?? "unscoped";
}

function equalStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
