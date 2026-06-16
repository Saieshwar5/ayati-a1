import type {
  MountedToolGroup,
  ToolExecutor,
  ToolGroupScope,
  ToolRegistryContext,
} from "./tool-executor.js";
import type { ToolDefinition, ToolExecutionContext } from "./types.js";
import type { SkillActivationScope, SkillBundle, SkillCatalog } from "./skill-catalog.js";

export interface ActiveSkillRecord {
  skillId: string;
  groupId: string;
  scope: SkillActivationScope;
  clientId?: string;
  runId?: string;
  sessionId?: string;
  activatedAtStep?: number;
  lastUsedAtStep?: number;
  expiresAfterStep?: number;
  reason: string;
  toolNames: string[];
}

export interface SkillActivationManagerOptions {
  catalog: SkillCatalog;
  toolExecutor: ToolExecutor;
  maxActiveBuiltInSkills?: number;
}

export interface SkillSearchInput {
  query: string;
  limit?: number;
}

export interface SkillActivateInput {
  skillId: string;
  scope?: SkillActivationScope;
  reason?: string;
}

export interface SkillDeactivateInput {
  skillId?: string;
}

export interface ActivationRouterState {
  attachedDocuments?: unknown[];
  preparedAttachments?: unknown[];
  managedFiles?: unknown[];
  managedDirectories?: unknown[];
  activeFocus?: unknown[];
  sessionFocusCards?: unknown[];
  attentionShelf?: unknown[];
}

const DEFAULT_MAX_ACTIVE_BUILT_IN_SKILLS = 4;
const ATTACHMENT_SKILL_IDS = ["attachments", "files", "documents", "datasets"];

export class SkillActivationManager {
  private readonly catalog: SkillCatalog;
  private readonly toolExecutor: ToolExecutor;
  private readonly maxActiveBuiltInSkills: number;
  private readonly active = new Map<string, ActiveSkillRecord>();
  private readonly toolToSkill = new Map<string, string>();

  constructor(options: SkillActivationManagerOptions) {
    this.catalog = options.catalog;
    this.toolExecutor = options.toolExecutor;
    this.maxActiveBuiltInSkills = options.maxActiveBuiltInSkills ?? DEFAULT_MAX_ACTIVE_BUILT_IN_SKILLS;

    for (const card of this.catalog.listCards()) {
      const bundle = this.catalog.getBundle(card.id);
      for (const tool of bundle?.tools ?? []) {
        this.toolToSkill.set(tool.name, card.id);
      }
    }
  }

  getPromptBlock(): string {
    return this.catalog.promptBlock();
  }

  async search(input: SkillSearchInput): Promise<unknown[]> {
    const limit = input.limit && input.limit > 0 ? Math.floor(input.limit) : 5;
    return this.catalog.search(input.query, limit).map((result) => ({
      source: "built_in",
      ...result,
    }));
  }

  async describe(skillId: string): Promise<unknown | null> {
    const bundle = this.catalog.getBundle(skillId);
    if (bundle) {
      return {
        type: "built_in",
        skillId: bundle.card.id,
        title: bundle.card.title,
        summary: bundle.card.summary,
        whenToUse: bundle.card.whenToUse,
        notFor: bundle.card.notFor,
        domains: bundle.card.domains,
        triggers: bundle.card.triggers,
        risk: bundle.card.risk,
        defaultScope: bundle.card.defaultScope,
        tools: bundle.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          annotations: tool.annotations,
          inputSummary: summarizeInputSchema(tool),
        })),
      };
    }

    return null;
  }

  async activate(input: SkillActivateInput, context?: ToolExecutionContext): Promise<{ ok: boolean; error?: string; activation?: unknown }> {
    const bundle = this.catalog.getBundle(input.skillId);
    if (!bundle) {
      return { ok: false, error: `Unknown skill: ${input.skillId}` };
    }

    const existing = this.findActive(input.skillId, context);
    if (existing) {
      this.touchRecord(existing, context);
      return {
        ok: true,
        activation: {
          skillId: existing.skillId,
          scope: existing.scope,
          status: "already_active",
          toolNames: existing.toolNames,
          groupId: existing.groupId,
        },
      };
    }

    const scope = input.scope ?? bundle.card.defaultScope;
    const groupId = this.buildGroupId(bundle.card.id, scope, context);
    const expiresAfterStep = scope === "step" && typeof context?.stepNumber === "number"
      ? context.stepNumber + 1
      : undefined;

    this.evictIfNeeded(context);
    this.toolExecutor.mount?.(groupId, bundle.tools, {
      scope: toToolGroupScope(scope),
      clientId: context?.clientId,
      runId: context?.runId,
      sessionId: context?.sessionId,
      activatedAtStep: context?.stepNumber,
      expiresAfterStep,
      skillId: bundle.card.id,
      toolIds: bundle.tools.map((tool) => tool.name),
      description: bundle.card.summary,
    });

    const record: ActiveSkillRecord = {
      skillId: bundle.card.id,
      groupId,
      scope,
      ...(context?.clientId ? { clientId: context.clientId } : {}),
      ...(context?.runId ? { runId: context.runId } : {}),
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      ...(typeof context?.stepNumber === "number" ? { activatedAtStep: context.stepNumber, lastUsedAtStep: context.stepNumber } : {}),
      ...(typeof expiresAfterStep === "number" ? { expiresAfterStep } : {}),
      reason: input.reason?.trim() || "manual activation",
      toolNames: bundle.tools.map((tool) => tool.name),
    };
    this.active.set(groupId, record);

    return {
      ok: true,
      activation: {
        skillId: record.skillId,
        scope: record.scope,
        status: "activated",
        toolNames: record.toolNames,
        groupId: record.groupId,
        reason: record.reason,
      },
    };
  }

  deactivate(input: SkillDeactivateInput = {}, context?: ToolExecutionContext): { builtIn: ActiveSkillRecord[] } {
    const removed: ActiveSkillRecord[] = [];
    for (const record of this.getActiveRecords(context)) {
      if (input.skillId && record.skillId !== input.skillId) {
        continue;
      }
      this.toolExecutor.unmount?.(record.groupId);
      this.active.delete(record.groupId);
      removed.push(cloneRecord(record));
    }

    return {
      builtIn: removed,
    };
  }

  listActive(context?: ToolExecutionContext): { builtIn: ActiveSkillRecord[] } {
    return {
      builtIn: this.getActiveRecords(context).map(cloneRecord),
    };
  }

  async prepareForDecision(state: ActivationRouterState, context: ToolExecutionContext): Promise<ActiveSkillRecord[]> {
    if (!hasAttachmentWork(state)) {
      return [];
    }

    const activated: ActiveSkillRecord[] = [];
    for (const skillId of ATTACHMENT_SKILL_IDS) {
      const result = await this.activate({
        skillId,
        scope: "run",
        reason: hasCurrentRunAttachments(state) ? "incoming attachment" : "focus continuation attachment",
      }, context);
      if (!result.ok) {
        continue;
      }
      const record = this.findActive(skillId, context);
      if (record) {
        activated.push(cloneRecord(record));
      }
    }
    return activated;
  }

  cleanupAfterStep(toolsUsed: string[], context: ToolExecutionContext): string[] {
    const stepNumber = context.stepNumber;
    for (const toolName of toolsUsed) {
      const skillId = this.toolToSkill.get(toolName);
      if (!skillId) {
        continue;
      }
      const record = this.findActive(skillId, context);
      if (record && typeof stepNumber === "number") {
        record.lastUsedAtStep = stepNumber;
      }
    }

    const removedGroupIds = new Set(this.toolExecutor.cleanupExpired?.(context) ?? []);
    for (const groupId of removedGroupIds) {
      this.active.delete(groupId);
    }
    return [...removedGroupIds];
  }

  deactivateRun(context: ToolExecutionContext): ActiveSkillRecord[] {
    return this.deactivate({}, context).builtIn;
  }

  private evictIfNeeded(context?: ToolExecutionContext): void {
    const activeRecords = this.getActiveRecords(context)
      .filter((record) => record.scope !== "session")
      .sort((left, right) => (left.lastUsedAtStep ?? 0) - (right.lastUsedAtStep ?? 0));
    const overflowCount = Math.max(0, activeRecords.length + 1 - this.maxActiveBuiltInSkills);
    for (const record of activeRecords.slice(0, overflowCount)) {
      this.toolExecutor.unmount?.(record.groupId);
      this.active.delete(record.groupId);
    }
  }

  private getActiveRecords(context?: ToolExecutionContext): ActiveSkillRecord[] {
    return [...this.active.values()].filter((record) => recordMatchesContext(record, context));
  }

  private findActive(skillId: string, context?: ToolExecutionContext): ActiveSkillRecord | undefined {
    return this.getActiveRecords(context).find((record) => record.skillId === skillId);
  }

  private touchRecord(record: ActiveSkillRecord, context?: ToolExecutionContext): void {
    if (typeof context?.stepNumber === "number") {
      record.lastUsedAtStep = context.stepNumber;
    }
  }

  private buildGroupId(skillId: string, scope: SkillActivationScope, context?: ToolExecutionContext): string {
    const sessionId = context?.sessionId ?? "global";
    const runId = scope === "run" || scope === "step" ? context?.runId ?? "global" : "session";
    return `dynamic:${scope}:${sessionId}:${runId}:${skillId}`;
  }
}

function hasAttachmentWork(state: ActivationRouterState): boolean {
  return hasCurrentRunAttachments(state) || hasFocusArtifactContext(state);
}

function hasCurrentRunAttachments(state: ActivationRouterState): boolean {
  return [
    state.attachedDocuments,
    state.preparedAttachments,
    state.managedFiles,
    state.managedDirectories,
  ].some((items) => Array.isArray(items) && items.length > 0);
}

function hasFocusArtifactContext(state: ActivationRouterState): boolean {
  return [
    state.activeFocus,
    state.sessionFocusCards,
    state.attentionShelf,
  ].some((items) => Array.isArray(items) && items.some(hasTopArtifacts));
}

function hasTopArtifacts(item: unknown): boolean {
  return Boolean(
    item
      && typeof item === "object"
      && !Array.isArray(item)
      && Array.isArray((item as { topArtifacts?: unknown[] }).topArtifacts)
      && ((item as { topArtifacts: unknown[] }).topArtifacts).length > 0,
  );
}

function toToolGroupScope(scope: SkillActivationScope): ToolGroupScope {
  return scope;
}

function recordMatchesContext(record: ActiveSkillRecord, context?: ToolExecutionContext): boolean {
  if (record.clientId && context?.clientId && record.clientId !== context.clientId) {
    return false;
  }
  if (record.sessionId && context?.sessionId && record.sessionId !== context.sessionId) {
    return false;
  }
  if ((record.scope === "run" || record.scope === "step") && record.runId && context?.runId && record.runId !== context.runId) {
    return false;
  }
  return true;
}

function cloneRecord(record: ActiveSkillRecord): ActiveSkillRecord {
  return {
    ...record,
    toolNames: [...record.toolNames],
  };
}

function summarizeInputSchema(tool: ToolDefinition): string {
  const schema = tool.inputSchema;
  if (!schema) {
    return "";
  }
  const properties = (schema["properties"] ?? {}) as Record<string, { type?: string }>;
  const required = new Set((schema["required"] as string[] | undefined) ?? []);
  return Object.entries(properties)
    .map(([name, prop]) => `${name}${required.has(name) ? "*" : ""}${prop.type ? `:${prop.type}` : ""}`)
    .join(", ");
}

export function mountedGroupSkillId(group: MountedToolGroup): string | undefined {
  return group.meta.skillId;
}
