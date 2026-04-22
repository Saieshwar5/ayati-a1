import type { ToolDefinition } from "../types.js";
import type { ToolExecutor } from "../tool-executor.js";
import type {
  ExternalSkillCard,
  ExternalSkillDetail,
  ExternalSkillRegistry,
  ExternalSkillSearchResult,
} from "./registry.js";

interface MountedExternalTool {
  toolName: string;
  groupId: string;
  definition: ToolDefinition;
}

export interface LoadedExternalTool {
  toolName: string;
  title: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface LoadedExternalToolResult {
  skillId: string;
  loaded: LoadedExternalTool[];
  alreadyLoaded: LoadedExternalTool[];
  missing: string[];
  blockedReason?: string;
}

export interface AutoMountedExternalToolResult {
  requested: string[];
  loaded: LoadedExternalTool[];
  alreadyLoaded: LoadedExternalTool[];
  missing: string[];
  blockedReason?: string;
}

export interface RunExternalToolWindowOptions {
  registry: ExternalSkillRegistry;
  toolExecutor?: ToolExecutor;
  clientId: string;
  runId: string;
  sessionId: string;
  maxVisibleTools?: number;
}

export class RunExternalToolWindow {
  private readonly registry: ExternalSkillRegistry;
  private readonly toolExecutor?: ToolExecutor;
  private readonly clientId: string;
  private readonly runId: string;
  private readonly sessionId: string;
  private readonly maxVisibleTools: number;
  private readonly mounted = new Map<string, MountedExternalTool>();
  private readonly visibleOrder: string[] = [];
  private readonly unavailableGroupIds = new Map<string, string>();

  constructor(options: RunExternalToolWindowOptions) {
    this.registry = options.registry;
    this.toolExecutor = options.toolExecutor;
    this.clientId = options.clientId;
    this.runId = options.runId;
    this.sessionId = options.sessionId;
    this.maxVisibleTools = options.maxVisibleTools ?? 20;
  }

  getSkillCards(): ExternalSkillCard[] {
    return this.registry.getSkillCards();
  }

  searchSkills(query: string, limit = 5): ExternalSkillSearchResult[] {
    return this.registry.searchSkills(query, limit);
  }

  describeSkill(skillId: string): ExternalSkillDetail | undefined {
    return this.registry.getSkillDetail(skillId);
  }

  loadTools(skillId: string, toolNames: string[]): LoadedExternalToolResult {
    const resolved = this.registry.resolveSkillToolNames(skillId, toolNames);
    const mounted = this.mountReferencedTools(resolved.resolved);

    return {
      skillId,
      loaded: mounted.loaded,
      alreadyLoaded: mounted.alreadyLoaded,
      missing: resolved.missing,
      ...(mounted.blockedReason ? { blockedReason: mounted.blockedReason } : {}),
    };
  }

  mountReferencedTools(toolNames: string[]): AutoMountedExternalToolResult {
    const requested = [...new Set(toolNames.map((toolName) => toolName.trim()).filter((toolName) => toolName.length > 0))];
    const missing = requested.filter((toolName) => !this.registry.getToolDefinition(toolName));
    if (missing.length > 0) {
      return {
        requested,
        loaded: [],
        alreadyLoaded: [],
        missing,
      };
    }

    const unloaded = requested.filter((toolName) => !this.mounted.has(toolName));
    const projectedVisibleCount = this.visibleOrder.length + unloaded.length;
    if (projectedVisibleCount > this.maxVisibleTools) {
      return {
        requested,
        loaded: [],
        alreadyLoaded: requested
          .filter((toolName) => this.mounted.has(toolName))
          .map((toolName) => this.toLoadedExternalTool(toolName))
          .filter((tool): tool is LoadedExternalTool => !!tool),
        missing: [],
        blockedReason: `Mounting ${unloaded.length} new external tool(s) would exceed the visible external-tool limit of ${this.maxVisibleTools}.`,
      };
    }

    const loaded: LoadedExternalTool[] = [];
    const alreadyLoaded: LoadedExternalTool[] = [];
    for (const toolName of requested) {
      const existing = this.mounted.get(toolName);
      if (existing) {
        this.touch(toolName);
        const summary = this.toLoadedExternalTool(toolName);
        if (summary) {
          alreadyLoaded.push(summary);
        }
        continue;
      }

      const definition = this.mountLoadedTool(toolName);
      if (!definition) {
        continue;
      }
      this.touch(toolName);
      const summary = this.toLoadedExternalTool(toolName, definition);
      if (summary) {
        loaded.push(summary);
      }
    }

    return {
      requested,
      loaded,
      alreadyLoaded,
      missing: [],
    };
  }

  ensureLoaded(toolNames: string[]): { found: ToolDefinition[]; missing: string[] } {
    const found: ToolDefinition[] = [];
    const missing: string[] = [];

    for (const toolName of [...new Set(toolNames)]) {
      const mounted = this.mounted.get(toolName);
      if (mounted) {
        found.push(mounted.definition);
        continue;
      }

      this.mountUnavailableTool(toolName, `External tool "${toolName}" is not loaded for this run.`);
      missing.push(toolName);
    }

    return { found, missing };
  }

  touch(toolName: string): void {
    const existingIndex = this.visibleOrder.indexOf(toolName);
    if (existingIndex >= 0) {
      this.visibleOrder.splice(existingIndex, 1);
    }
    this.visibleOrder.unshift(toolName);
  }

  getVisibleDefinitions(): ToolDefinition[] {
    return this.visibleOrder
      .map((toolName) => this.mounted.get(toolName)?.definition)
      .filter((definition): definition is ToolDefinition => !!definition);
  }

  cleanup(): void {
    for (const mounted of this.mounted.values()) {
      this.toolExecutor?.unmount?.(mounted.groupId);
    }
    this.mounted.clear();
    for (const groupId of this.unavailableGroupIds.values()) {
      this.toolExecutor?.unmount?.(groupId);
    }
    this.unavailableGroupIds.clear();
    this.visibleOrder.splice(0, this.visibleOrder.length);
  }

  private mountLoadedTool(toolName: string): ToolDefinition | undefined {
    const existing = this.mounted.get(toolName);
    if (existing) {
      return existing.definition;
    }

    const definition = this.registry.getToolDefinition(toolName);
    if (!definition) {
      this.mountUnavailableTool(toolName);
      return undefined;
    }

    if (this.toolExecutor?.mount) {
      const groupId = this.buildGroupId(toolName);
      this.toolExecutor.mount(groupId, [definition], {
        scope: "run",
        clientId: this.clientId,
        runId: this.runId,
        sessionId: this.sessionId,
        skillId: toolName.split(".")[0],
        toolIds: [toolName.split(".").slice(1).join(".")],
        description: definition.description,
      });
      this.mounted.set(toolName, { toolName, groupId, definition });
      return definition;
    }

    this.mounted.set(toolName, { toolName, groupId: this.buildGroupId(toolName), definition });
    return definition;
  }

  private toLoadedExternalTool(toolName: string, definitionOverride?: ToolDefinition): LoadedExternalTool | undefined {
    const definition = definitionOverride ?? this.mounted.get(toolName)?.definition ?? this.registry.getToolDefinition(toolName);
    if (!definition) {
      return undefined;
    }
    const summary = this.registry.getToolSummary(toolName);
    return {
      toolName,
      title: summary?.title ?? toolName,
      description: summary?.description ?? definition.description,
      ...(definition.inputSchema ? { inputSchema: definition.inputSchema } : {}),
    };
  }

  private buildGroupId(toolName: string): string {
    return `external:run:${this.sessionId}:${this.runId}:${toolName}`;
  }

  private mountUnavailableTool(toolName: string, explicitError?: string): void {
    if (!this.toolExecutor?.mount || this.unavailableGroupIds.has(toolName)) {
      return;
    }

    const skillId = toolName.split(".")[0] ?? toolName;
    const quarantinedReason = this.registry.getQuarantinedSkills()
      .find((entry) => entry.skillId === skillId)
      ?.reason;
    const error = explicitError ?? (quarantinedReason
      ? `External tool "${toolName}" is runtime-inactive: ${quarantinedReason}`
      : `External tool "${toolName}" is not available in the active preloaded external skill registry. Fix the skill manifest and restart the agent.`);
    const groupId = `external:missing:${this.sessionId}:${this.runId}:${toolName}`;
    this.toolExecutor.mount(groupId, [{
      name: toolName,
      description: error,
      execute: async () => ({ ok: false, error }),
    }], {
      scope: "run",
      clientId: this.clientId,
      runId: this.runId,
      sessionId: this.sessionId,
      skillId,
      toolIds: [toolName.split(".").slice(1).join(".") || toolName],
      description: error,
    });
    this.unavailableGroupIds.set(toolName, groupId);
  }
}
