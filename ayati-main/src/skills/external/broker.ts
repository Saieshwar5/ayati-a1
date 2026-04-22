import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolExecutionContext, ToolSelectionHints } from "../types.js";
import type {
  BrokerExecutionRequest,
  BrokerExecutionResult,
  ExternalCommandArgSpec,
  ExternalCommandOutputMode,
  ExternalSkillCatalog,
  ExternalSkillScanRoot,
  ExternalToolWindowEntry,
  NormalizedExternalSkill,
  NormalizedExternalTool,
  ReadinessReason,
  ResolvedSecret,
  SecretResolver,
  SkillActivationRecord,
  SkillAdapterContext,
  SkillAdapterModule,
  SkillReadinessState,
  SkillSearchKind,
  ToolReadinessState,
} from "./types.js";
import { buildExternalCapabilityDigest, getExternalSkillById, loadExternalSkillCatalog, searchExternalSkillCatalog } from "./catalog.js";
import { normalizeScanRoots } from "./scanner.js";
import type { ToolExecutor } from "../tool-executor.js";
import { devWarn } from "../../shared/index.js";

const execFileAsync = promisify(execFile);
const MAX_ACTIVE_EXTERNAL_SKILLS = 5;
const FINGERPRINT_HASH_ALGORITHM = "sha1";

interface SecretMappingEntry {
  source?: "env";
  env?: string;
}

interface SkillPolicyConfig {
  defaultMode?: "allow" | "ask" | "deny";
  capabilities?: Record<string, "allow" | "ask" | "deny">;
}

interface PluginRuntimeStatus {
  name: string;
  loaded: boolean;
  started: boolean;
}

export interface ExternalSkillBrokerOptions {
  roots: Array<string | ExternalSkillScanRoot>;
  cachePath?: string;
  secretMappingPath: string;
  policyPath: string;
  toolExecutor: ToolExecutor;
  pluginStatusProvider?: (name: string) => PluginRuntimeStatus | undefined;
}

interface SkillSearchInput {
  query: string;
  kind?: SkillSearchKind;
  limit?: number;
  installedOnly?: boolean;
}

interface SkillActivateInput {
  skillId: string;
}

export interface ActiveExternalSkillContext {
  skillId: string;
  title: string;
  summary: string;
  whenToUse: string;
  activationBrief: string;
  workflow: string[];
  rules: string[];
  toolNames: string[];
  toolSummaries: string[];
  activatedAtStep?: number;
}

interface ResolvedSecretsBundle {
  env: Record<string, string>;
  values: Record<string, string>;
  valueList: string[];
}

interface ExecErrorWithOutput extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
  signal?: NodeJS.Signals;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateCapabilityPolicy(
  capabilities: string[],
  policy: SkillPolicyConfig,
): { ok: boolean; code?: ReadinessReason["code"]; error?: string } {
  const defaultMode = policy.defaultMode ?? "allow";
  for (const capability of capabilities) {
    const mode = policy.capabilities?.[capability] ?? defaultMode;
    if (mode === "deny") {
      return { ok: false, code: "policy_denied", error: `Capability denied by policy: ${capability}` };
    }
    if (mode === "ask") {
      return { ok: false, code: "policy_requires_approval", error: `Capability requires approval before execution: ${capability}` };
    }
  }
  return { ok: true };
}

function dedupeReasons(reasons: ReadinessReason[]): ReadinessReason[] {
  const seen = new Set<string>();
  const deduped: ReadinessReason[] = [];

  for (const reason of reasons) {
    const key = `${reason.code}:${reason.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(reason);
  }

  return deduped;
}

async function loadJsonFile<T>(pathValue: string, fallback: T): Promise<T> {
  try {
    if (!existsSync(pathValue)) {
      return fallback;
    }
    const raw = await readFile(pathValue, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    devWarn(`Failed to load JSON file ${pathValue}: ${err instanceof Error ? err.message : String(err)}`);
    return fallback;
  }
}

async function buildPathStamp(pathValue: string): Promise<string> {
  try {
    const fileStat = await stat(pathValue);
    return `${pathValue}:${fileStat.mtimeMs}:${fileStat.size}`;
  } catch {
    return `${pathValue}:missing`;
  }
}

async function buildRootFingerprintParts(root: ExternalSkillScanRoot): Promise<string[]> {
  const parts: string[] = [`root:${root.skillsDir}:${root.source ?? "project"}`];
  const entries = await readdir(root.skillsDir).catch(() => []);

  for (const entry of entries.sort()) {
    const skillDir = join(root.skillsDir, entry);
    const entryStat = await stat(skillDir).catch(() => null);
    if (!entryStat?.isDirectory()) {
      continue;
    }

    parts.push(`dir:${skillDir}:${entryStat.mtimeMs}`);
    for (const fileName of ["skill.json", "skill.md", "SKILL.md", "adapter.js", "adapter.ts"]) {
      parts.push(await buildPathStamp(join(skillDir, fileName)));
    }

    const toolEntries = await readdir(join(skillDir, "tools")).catch(() => []);
    for (const toolEntry of toolEntries.sort()) {
      if (!toolEntry.endsWith(".json")) {
        continue;
      }
      parts.push(await buildPathStamp(join(skillDir, "tools", toolEntry)));
    }
  }

  return parts;
}

class MappedSecretResolver implements SecretResolver {
  private readonly mappingPath: string;
  private mapping: Record<string, SecretMappingEntry> = {};

  constructor(mappingPath: string) {
    this.mappingPath = mappingPath;
  }

  async initialize(): Promise<void> {
    this.mapping = await loadJsonFile<Record<string, SecretMappingEntry>>(this.mappingPath, {});
  }

  async resolve(ref: string): Promise<ResolvedSecret> {
    const entry = this.mapping[ref];
    if (!entry?.env) {
      return { ok: false, ref, missing: true, error: `No secret mapping configured for ${ref}` };
    }

    const value = process.env[entry.env];
    if (!value) {
      return { ok: false, ref, missing: true, source: entry.source ?? "env", error: `Missing environment variable ${entry.env}` };
    }

    return {
      ok: true,
      ref,
      source: entry.source ?? "env",
      env: { [entry.env]: value },
      value,
    };
  }

  async inspect(ref: string): Promise<{ ok: boolean; ref: string; source?: string; env?: string; missing?: boolean; error?: string }> {
    const entry = this.mapping[ref];
    if (!entry?.env) {
      return { ok: false, ref, missing: true, error: `No secret mapping configured for ${ref}` };
    }

    return {
      ok: Boolean(process.env[entry.env]),
      ref,
      source: entry.source ?? "env",
      env: entry.env,
      missing: !process.env[entry.env],
      ...(process.env[entry.env] ? {} : { error: `Missing environment variable ${entry.env}` }),
    };
  }
}

export class ExternalSkillBroker {
  private readonly options: ExternalSkillBrokerOptions;
  private readonly secrets: MappedSecretResolver;
  private policy: SkillPolicyConfig = { defaultMode: "allow", capabilities: {} };
  private catalog: ExternalSkillCatalog = {
    generatedAt: new Date(0).toISOString(),
    roots: [],
    skills: [],
  };
  private stateFingerprint = "";
  private readonly windowEntries = new Map<string, ExternalToolWindowEntry>();
  private orderCounter = 0;

  constructor(options: ExternalSkillBrokerOptions) {
    this.options = options;
    this.secrets = new MappedSecretResolver(options.secretMappingPath);
  }

  async initialize(): Promise<void> {
    const fingerprint = await this.computeStateFingerprint();
    await this.reloadState(fingerprint);
  }

  getPromptBlock(): string {
    return buildExternalCapabilityDigest(this.catalog);
  }

  getCatalog(): ExternalSkillCatalog {
    return this.catalog;
  }

  async search(input: SkillSearchInput) {
    await this.ensureFreshState();

    const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 5;
    const candidateResults = searchExternalSkillCatalog(this.catalog, input.query, {
      kind: input.kind ?? "tool",
      limit: Math.max(limit * 4, 20),
      installedOnly: typeof input.installedOnly === "boolean" ? input.installedOnly : false,
    });

    const filtered = [];
    for (const result of candidateResults) {
      if (result.type === "workflow") {
        filtered.push(result);
      } else {
        const toolState = await this.getToolReadinessState(result.skillId, result.toolId);
        if (toolState?.activatable) {
          filtered.push(result);
        }
      }

      if (filtered.length >= limit) {
        break;
      }
    }

    return filtered;
  }

  async describe(skillId: string) {
    await this.ensureFreshState();
    const skill = getExternalSkillById(this.catalog, skillId);
    if (!skill) {
      return null;
    }

    const readiness = await this.buildSkillReadinessState(skill);
    return {
      id: skill.id,
      title: skill.title,
      description: skill.description,
      workflowOnly: skill.workflowOnly,
      activatable: readiness.activatable,
      readinessReasons: readiness.reasons,
      domains: skill.domains,
      tags: skill.tags,
      aliases: skill.aliases,
      triggers: skill.triggers,
      docsPath: skill.docsPath,
      adapterPath: skill.adapterPath,
      integration: skill.integration,
      maxActiveTools: skill.maxActiveTools,
      tools: skill.tools.map((tool) => ({
        id: tool.id,
        toolName: `${skill.id}.${tool.id}`,
        title: tool.title,
        description: tool.description,
        action: tool.action,
        object: tool.object,
        provider: tool.provider,
        aliases: tool.aliases,
        tags: tool.tags,
        triggers: tool.triggers,
        readiness: readiness.tools.find((state) => state.toolId === tool.id) ?? null,
      })),
      legacyCommands: skill.legacyCommands,
    };
  }

  async health(skillId?: string) {
    await this.ensureFreshState();
    const skills = skillId
      ? this.catalog.skills.filter((skill) => skill.id === skillId)
      : this.catalog.skills;

    return Promise.all(skills.map(async (skill) => {
      const readiness = await this.buildSkillReadinessState(skill);
      return {
        skillId: skill.id,
        workflowOnly: skill.workflowOnly,
        activatable: readiness.activatable,
        reasons: readiness.reasons,
        dependencyChecks: skill.dependencyChecks,
        secrets: await Promise.all((skill.auth.secretRefs ?? []).map((ref) => this.secrets.inspect(ref))),
        plugin: skill.integration?.plugin
          ? this.options.pluginStatusProvider?.(skill.integration.plugin.name) ?? {
            name: skill.integration.plugin.name,
            loaded: false,
            started: false,
          }
          : undefined,
        tools: readiness.tools,
      };
    }));
  }

  listActive(context?: ToolExecutionContext) {
    this.pruneUnmountedWindowEntries(context);
    const tools = this.getWindowEntriesForContext(context)
      .sort((left, right) => right.order - left.order || left.toolName.localeCompare(right.toolName))
      .map((entry) => this.cloneWindowEntry(entry));
    const skillGroups = this.getActiveSkillGroups(context);

    return {
      tools,
      skills: skillGroups.map((group) => ({
        skillId: group.skill.id,
        title: group.skill.title,
        summary: group.skill.cardSummary,
        whenToUse: group.skill.cardWhenToUse,
        activationBrief: group.skill.activationBrief,
        workflow: [...group.skill.activationWorkflow],
        rules: [...group.skill.activationRules],
        toolIds: group.entries.map((entry) => entry.toolId),
        toolNames: group.entries.map((entry) => entry.toolName),
      })),
      windowSize: skillGroups.length,
    };
  }

  getActiveSkillContexts(context?: ToolExecutionContext): ActiveExternalSkillContext[] {
    this.pruneUnmountedWindowEntries(context);
    return this.getActiveSkillGroups(context).map((group) => ({
      skillId: group.skill.id,
      title: group.skill.title,
      summary: group.skill.cardSummary,
      whenToUse: group.skill.cardWhenToUse,
      activationBrief: group.skill.activationBrief,
      workflow: [...group.skill.activationWorkflow],
      rules: [...group.skill.activationRules],
      toolNames: group.entries.map((entry) => entry.toolName),
      toolSummaries: group.skill.tools
        .map((tool) => `${group.skill.id}.${tool.id}: ${tool.description}`)
        .sort((left, right) => left.localeCompare(right)),
      ...(typeof group.entries[0]?.activatedAtStep === "number" ? { activatedAtStep: group.entries[0]?.activatedAtStep } : {}),
    }));
  }

  deactivate(input: { skillId?: string }, context?: ToolExecutionContext): ExternalToolWindowEntry[] {
    this.pruneUnmountedWindowEntries(context);
    const removed: ExternalToolWindowEntry[] = [];

    for (const entry of this.getWindowEntriesForContext(context)) {
      if (input.skillId && entry.skillId !== input.skillId) {
        continue;
      }
      this.options.toolExecutor.unmount?.(entry.groupId);
      this.windowEntries.delete(entry.groupId);
      removed.push(this.cloneWindowEntry(entry));
    }

    return removed;
  }

  cleanupExpired(context: ToolExecutionContext): void {
    const removedGroupIds = new Set(this.options.toolExecutor.cleanupExpired?.(context) ?? []);
    if (removedGroupIds.size === 0) {
      return;
    }

    for (const groupId of removedGroupIds) {
      this.windowEntries.delete(groupId);
    }
  }

  async activate(input: SkillActivateInput, context?: ToolExecutionContext): Promise<{ ok: boolean; error?: string; activation?: SkillActivationRecord }> {
    await this.ensureFreshState();

    const skill = getExternalSkillById(this.catalog, input.skillId);
    if (!skill) {
      return { ok: false, error: `Unknown external skill: ${input.skillId}` };
    }

    const readiness = await this.buildSkillReadinessState(skill);
    if (skill.workflowOnly || skill.tools.length === 0) {
      return { ok: false, error: `External skill "${skill.id}" is workflow-only and cannot be activated as typed tools.` };
    }
    const selectedToolStates = readiness.tools.filter((state) => state.activatable);

    if (selectedToolStates.length === 0) {
      return {
        ok: false,
        error: readiness.reasons[0]?.message ?? `External skill "${skill.id}" is not ready to activate.`,
      };
    }

    this.pruneUnmountedWindowEntries(context);
    const activeEntries = this.getWindowEntriesForContext(context)
      .sort((left, right) => left.order - right.order || left.toolName.localeCompare(right.toolName));
    const selectedToolNames = new Set(selectedToolStates.map((state) => state.toolName));
    const existingSkillEntries = activeEntries.filter((entry) => entry.skillId === skill.id);
    const existingToolNames = new Set(existingSkillEntries.map((entry) => entry.toolName));
    const alreadyActive = existingSkillEntries.length > 0
      && existingSkillEntries.length === selectedToolNames.size
      && [...selectedToolNames].every((toolName) => existingToolNames.has(toolName));
    if (alreadyActive) {
      return {
        ok: true,
        activation: {
          skillId: skill.id,
          scope: "run",
          status: "already_active",
          activatedTools: existingSkillEntries.map((entry) => this.cloneWindowEntry(entry)),
          evictedTools: [],
          evictedSkills: [],
          windowSize: this.getActiveSkillGroups(context).length,
          activationBrief: skill.activationBrief,
        },
      };
    }

    for (const entry of existingSkillEntries) {
      this.options.toolExecutor.unmount?.(entry.groupId);
      this.windowEntries.delete(entry.groupId);
    }

    const otherSkillGroups = this.getActiveSkillGroups(context)
      .filter((group) => group.skill.id !== skill.id);
    const overflowCount = Math.max(0, otherSkillGroups.length + 1 - MAX_ACTIVE_EXTERNAL_SKILLS);
    const evictedSkillGroups = otherSkillGroups.slice(0, overflowCount);
    const evictedEntries = evictedSkillGroups.flatMap((group) => group.entries.map((entry) => this.cloneWindowEntry(entry)));
    for (const group of evictedSkillGroups) {
      for (const entry of group.entries) {
        this.options.toolExecutor.unmount?.(entry.groupId);
        this.windowEntries.delete(entry.groupId);
      }
    }

    const activatedEntries: ExternalToolWindowEntry[] = [];
    for (const selected of selectedToolStates) {
      const tool = skill.tools.find((candidate) => candidate.id === selected.toolId);
      if (!tool) {
        continue;
      }
      activatedEntries.push(this.mountExternalTool(skill, tool, context));
    }

    return {
      ok: true,
      activation: {
        skillId: skill.id,
        scope: "run",
        status: "activated",
        activatedTools: activatedEntries.map((entry) => this.cloneWindowEntry(entry)),
        evictedTools: evictedEntries.map((entry) => this.cloneWindowEntry(entry)),
        evictedSkills: evictedSkillGroups.map((group) => group.skill.id),
        windowSize: this.getActiveSkillGroups(context).length,
        activationBrief: skill.activationBrief,
      },
    };
  }

  private async ensureFreshState(): Promise<void> {
    const fingerprint = await this.computeStateFingerprint();
    if (fingerprint === this.stateFingerprint) {
      return;
    }

    await this.reloadState(fingerprint);
  }

  private async reloadState(fingerprint: string): Promise<void> {
    await this.secrets.initialize();
    this.policy = await loadJsonFile<SkillPolicyConfig>(this.options.policyPath, { defaultMode: "allow", capabilities: {} });
    this.catalog = await loadExternalSkillCatalog(this.options.roots, { cachePath: this.options.cachePath });
    this.stateFingerprint = fingerprint;
  }

  private async computeStateFingerprint(): Promise<string> {
    const parts = [
      await buildPathStamp(this.options.secretMappingPath),
      await buildPathStamp(this.options.policyPath),
    ];

    for (const root of normalizeScanRoots(this.options.roots)) {
      parts.push(...await buildRootFingerprintParts(root));
    }

    return createHash(FINGERPRINT_HASH_ALGORITHM).update(parts.join("|")).digest("hex");
  }

  private async buildSkillReadinessState(skill: NormalizedExternalSkill): Promise<SkillReadinessState> {
    const reasons: ReadinessReason[] = [];

    if (!skill.installed) {
      reasons.push({
        code: "missing_dependency",
        message: `Required dependencies are missing for ${skill.id}.`,
      });
    }

    reasons.push(...await this.buildSecretReasons(skill.auth.secretRefs ?? []));
    reasons.push(...this.buildCapabilityReasons(skill.policy.capabilities ?? []));
    reasons.push(...this.buildPluginRuntimeReasons(skill));

    if (skill.workflowOnly) {
      reasons.push({
        code: "workflow_only",
        message: `${skill.id} is a workflow-only skill and does not expose typed external tools.`,
      });
    }

    const dedupedSkillReasons = dedupeReasons(reasons);
    const tools = await Promise.all(skill.tools.map((tool) => this.buildToolReadinessState(skill, tool, dedupedSkillReasons)));

    return {
      skillId: skill.id,
      workflowOnly: skill.workflowOnly,
      activatable: !skill.workflowOnly && tools.some((toolState) => toolState.activatable),
      reasons: dedupedSkillReasons,
      tools,
    };
  }

  private async getToolReadinessState(skillId: string, toolId?: string): Promise<ToolReadinessState | null> {
    if (!toolId) {
      return null;
    }

    const skill = getExternalSkillById(this.catalog, skillId);
    if (!skill) {
      return null;
    }

    const readiness = await this.buildSkillReadinessState(skill);
    return readiness.tools.find((state) => state.toolId === toolId) ?? null;
  }

  private async buildToolReadinessState(
    skill: NormalizedExternalSkill,
    tool: NormalizedExternalTool,
    inheritedSkillReasons: ReadinessReason[],
  ): Promise<ToolReadinessState> {
    const reasons = [...inheritedSkillReasons];
    reasons.push(...await this.buildSecretReasons(tool.auth.secretRefs ?? []));
    reasons.push(...this.buildCapabilityReasons(tool.policy.capabilities ?? []));

    if (tool.execution.backend === "plugin") {
      reasons.push({
        code: "unsupported_backend",
        message: `${skill.id}.${tool.id} uses the plugin backend, which is cataloged but not activatable yet.`,
      });
    }

    if (tool.execution.backend === "node" && !skill.adapterPath) {
      reasons.push({
        code: "missing_adapter",
        message: `${skill.id}.${tool.id} requires an adapter module, but none is configured.`,
      });
    }

    if (tool.execution.backend === "http" && (!tool.execution.allowedDomains || tool.execution.allowedDomains.length === 0)) {
      reasons.push({
        code: "missing_http_allowlist",
        message: `${skill.id}.${tool.id} must declare allowedDomains before it can be activated.`,
      });
    }

    const dedupedReasons = dedupeReasons(reasons);
    return {
      skillId: skill.id,
      toolId: tool.id,
      toolName: `${skill.id}.${tool.id}`,
      activatable: dedupedReasons.length === 0,
      reasons: dedupedReasons,
    };
  }

  private async buildSecretReasons(secretRefs: string[]): Promise<ReadinessReason[]> {
    const reasons: ReadinessReason[] = [];

    for (const ref of [...new Set(secretRefs)]) {
      const inspection = await this.secrets.inspect(ref);
      if (!inspection.ok) {
        reasons.push({
          code: "missing_secret",
          message: inspection.error ?? `Missing secret ${ref}`,
        });
      }
    }

    return reasons;
  }

  private buildCapabilityReasons(capabilities: string[]): ReadinessReason[] {
    const check = validateCapabilityPolicy([...new Set(capabilities)], this.policy);
    if (check.ok || !check.error || !check.code) {
      return [];
    }

    return [{
      code: check.code,
      message: check.error,
    }];
  }

  private buildPluginRuntimeReasons(skill: NormalizedExternalSkill): ReadinessReason[] {
    if (!skill.integration?.plugin?.required) {
      return [];
    }

    const status = this.options.pluginStatusProvider?.(skill.integration.plugin.name);
    if (status?.loaded && status.started) {
      return [];
    }

    return [{
      code: "missing_plugin_runtime",
      message: `Plugin runtime "${skill.integration.plugin.name}" is required for ${skill.id}, but it is not loaded and started.`,
    }];
  }

  private mountExternalTool(skill: NormalizedExternalSkill, tool: NormalizedExternalTool, context?: ToolExecutionContext): ExternalToolWindowEntry {
    const toolName = `${skill.id}.${tool.id}`;
    const groupId = this.buildGroupId(context, toolName);
    const toolDefinition = this.buildToolDefinition(skill.id, tool.id);

    this.options.toolExecutor.mount?.(groupId, [toolDefinition], {
      scope: "run",
      clientId: context?.clientId,
      runId: context?.runId,
      sessionId: context?.sessionId,
      activatedAtStep: context?.stepNumber,
      skillId: skill.id,
      toolIds: [tool.id],
      description: skill.description,
    });

    const entry: ExternalToolWindowEntry = {
      groupId,
      skillId: skill.id,
      toolId: tool.id,
      toolName,
      title: tool.title,
      scope: "run",
      ...(context?.runId ? { runId: context.runId } : {}),
      ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
      ...(typeof context?.stepNumber === "number" ? { activatedAtStep: context.stepNumber, lastTouchedAtStep: context.stepNumber } : {}),
      order: ++this.orderCounter,
    };
    this.windowEntries.set(groupId, entry);
    return entry;
  }

  private buildToolDefinition(skillId: string, toolId: string): ToolDefinition {
    const skill = getExternalSkillById(this.catalog, skillId);
    const tool = skill?.tools.find((candidate) => candidate.id === toolId);
    const toolName = `${skillId}.${toolId}`;
    const selectionHints: ToolSelectionHints = {
      tags: [...(tool?.tags ?? [])],
      aliases: [...(tool?.aliases ?? [])],
      examples: [...(tool?.triggers.slice(0, 5) ?? [])],
      domain: skill?.domains[0] ?? tool?.provider ?? skillId,
      priority: 25,
    };

    return {
      name: toolName,
      description: tool?.description ?? `External tool ${toolName}`,
      ...(tool?.inputSchema ? { inputSchema: tool.inputSchema } : {}),
      selectionHints,
      execute: async (input, context) => this.executeTool(skillId, toolId, input, context),
    };
  }

  private async executeTool(
    skillId: string,
    toolId: string,
    input: unknown,
    context?: ToolExecutionContext,
  ): Promise<BrokerExecutionResult> {
    await this.ensureFreshState();

    const skill = getExternalSkillById(this.catalog, skillId);
    const toolName = `${skillId}.${toolId}`;
    if (!skill) {
      this.unmountToolByName(toolName, context);
      return { ok: false, error: `External tool ${toolName} is no longer installed.` };
    }

    const tool = skill.tools.find((candidate) => candidate.id === toolId);
    if (!tool) {
      this.unmountToolByName(toolName, context);
      return { ok: false, error: `External tool ${toolName} is no longer available.` };
    }

    const readiness = await this.buildSkillReadinessState(skill);
    const toolReadiness = readiness.tools.find((state) => state.toolId === toolId);
    if (!toolReadiness?.activatable) {
      this.unmountToolByName(toolName, context);
      return {
        ok: false,
        error: toolReadiness?.reasons[0]?.message ?? `External tool ${toolName} is no longer ready.`,
      };
    }

    this.touchWindowEntry(toolName, context);

    const secretRefs = [...new Set([...(skill.auth.secretRefs ?? []), ...(tool.auth.secretRefs ?? [])])];
    const resolvedSecrets = await this.buildResolvedSecrets(secretRefs);
    const request: BrokerExecutionRequest = { input, tool, skill, context };

    let result: BrokerExecutionResult;
    switch (tool.execution.backend) {
      case "command":
        result = await this.executeCommandTool(request, resolvedSecrets);
        break;
      case "http":
        result = await this.executeHttpTool(request, resolvedSecrets);
        break;
      case "plugin":
        result = {
          ok: false,
          error: `${toolName} uses the plugin backend, which is not activatable yet.`,
        };
        break;
      case "node":
        result = await this.executeNodeAdapter(request, resolvedSecrets);
        break;
      default:
        result = { ok: false, error: `Unsupported external execution backend for ${toolName}.` };
        break;
    }

    return this.redactExecutionResult(result, tool, resolvedSecrets.valueList);
  }

  private async buildResolvedSecrets(secretRefs: string[]): Promise<ResolvedSecretsBundle> {
    const env: Record<string, string> = {};
    const values: Record<string, string> = {};
    const valueList: string[] = [];

    for (const ref of secretRefs) {
      const resolved = await this.secrets.resolve(ref);
      if (!resolved.ok) {
        continue;
      }

      if (resolved.env) {
        Object.assign(env, resolved.env);
      }
      if (resolved.value) {
        values[ref] = resolved.value;
        valueList.push(resolved.value);
      }
    }

    return {
      env,
      values,
      valueList,
    };
  }

  private renderTemplate(template: string, input: Record<string, unknown>, secrets: Record<string, string>): string {
    return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, expr) => {
      const trimmed = String(expr).trim();
      if (trimmed.startsWith("secret:")) {
        return secrets[trimmed.slice("secret:".length).trim()] ?? "";
      }
      if (trimmed.startsWith("secret ")) {
        return secrets[trimmed.slice("secret ".length).trim()] ?? "";
      }

      const joinMatch = trimmed.match(/^join\s+([a-zA-Z0-9_]+)\s+['"]([^'"]+)['"]$/);
      if (joinMatch) {
        const key = joinMatch[1];
        const delimiter = joinMatch[2];
        if (!key || !delimiter) {
          return "";
        }
        const value = input[key];
        return Array.isArray(value) ? value.map(String).join(delimiter) : "";
      }

      const jsonMatch = trimmed.match(/^json\s+([a-zA-Z0-9_]+)$/);
      if (jsonMatch) {
        const key = jsonMatch[1];
        if (!key) {
          return "";
        }
        const value = input[key];
        return value === undefined ? "" : JSON.stringify(value);
      }

      const value = input[trimmed];
      if (value === undefined || value === null) {
        return "";
      }
      return Array.isArray(value) ? value.map(String).join(",") : String(value);
    });
  }

  private renderStructuredTemplateValue(
    value: unknown,
    input: Record<string, unknown>,
    secrets: Record<string, string>,
  ): unknown {
    if (typeof value === "string") {
      return this.renderTemplate(value, input, secrets);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.renderStructuredTemplateValue(item, input, secrets));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
          key,
          this.renderStructuredTemplateValue(nestedValue, input, secrets),
        ]),
      );
    }
    return value;
  }

  private getInputObject(input: unknown): Record<string, unknown> {
    return isPlainObject(input) ? input : {};
  }

  private stringifyCommandValue(value: unknown): string {
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    return JSON.stringify(value);
  }

  private buildArgsFromSpec(args: ExternalCommandArgSpec[], input: Record<string, unknown>, secrets: Record<string, string>): string[] {
    const built: string[] = [];

    for (const spec of args) {
      if (spec.from) {
        const value = input[spec.from];
        if (value === undefined || value === null) {
          continue;
        }

        if (typeof value === "boolean") {
          if (value && spec.flag) {
            built.push(spec.flag);
          }
          continue;
        }

        if (Array.isArray(value)) {
          const items = value
            .map((item) => this.stringifyCommandValue(item).trim())
            .filter((item) => item.length > 0);
          if (items.length === 0) {
            continue;
          }

          if (spec.repeat) {
            for (const item of items) {
              if (spec.flag) {
                built.push(spec.flag);
              }
              built.push(item);
            }
            continue;
          }

          if (spec.flag) {
            built.push(spec.flag);
          }
          built.push(items.join(spec.joinWith ?? ","));
          continue;
        }

        const renderedValue = this.stringifyCommandValue(value).trim();
        if (renderedValue.length === 0) {
          continue;
        }
        if (spec.flag) {
          built.push(spec.flag);
        }
        built.push(renderedValue);
        continue;
      }

      if (spec.value) {
        const renderedValue = this.renderTemplate(spec.value, input, secrets).trim();
        if (renderedValue.length === 0) {
          continue;
        }
        if (spec.flag) {
          built.push(spec.flag);
        }
        built.push(renderedValue);
        continue;
      }

      if (spec.flag) {
        built.push(spec.flag);
      }
    }

    return built;
  }

  private buildCommandArgs(tool: NormalizedExternalTool, input: Record<string, unknown>, secrets: Record<string, string>): string[] {
    if (tool.execution.backend !== "command") {
      return [];
    }

    if (Array.isArray(tool.execution.args) && tool.execution.args.length > 0) {
      return this.buildArgsFromSpec(tool.execution.args, input, secrets);
    }

    return (tool.execution.argsTemplate ?? [])
      .map((arg) => this.renderTemplate(arg, input, secrets).trim())
      .filter((arg) => arg.length > 0);
  }

  private resolveCommandCwd(skill: NormalizedExternalSkill, tool: NormalizedExternalTool, input: Record<string, unknown>, secrets: Record<string, string>): string {
    if (tool.execution.backend !== "command") {
      return skill.skillDir;
    }

    if (!tool.execution.cwdTemplate) {
      return skill.skillDir;
    }

    const rendered = this.renderTemplate(tool.execution.cwdTemplate, input, secrets).trim();
    if (rendered.length === 0) {
      return process.cwd();
    }

    return resolve(rendered);
  }

  private formatCommandSuccess(
    outputMode: ExternalCommandOutputMode | undefined,
    stdout: string,
    stderr: string,
  ): BrokerExecutionResult {
    const normalizedStdout = stdout.trim();
    const normalizedStderr = stderr.trim();
    const mode = outputMode ?? "envelope";

    if (mode === "text") {
      return {
        ok: true,
        output: normalizedStdout.length > 0 ? normalizedStdout : normalizedStderr,
      };
    }

    if (mode === "json-stdout") {
      if (normalizedStdout.length === 0) {
        return { ok: false, error: "External command returned empty stdout; expected JSON output." };
      }

      try {
        const parsed = JSON.parse(normalizedStdout);
        return {
          ok: true,
          output: JSON.stringify(parsed, null, 2),
          ...(normalizedStderr.length > 0 ? { meta: { stderr: normalizedStderr } } : {}),
        };
      } catch (err) {
        return {
          ok: false,
          error: `External command returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
          output: JSON.stringify({ stdout: normalizedStdout, stderr: normalizedStderr }, null, 2),
        };
      }
    }

    return {
      ok: true,
      output: JSON.stringify({
        stdout: normalizedStdout,
        stderr: normalizedStderr,
        exitCode: 0,
      }, null, 2),
    };
  }

  private formatCommandFailure(message: string, stdout: string, stderr: string, exitCode: number | null): BrokerExecutionResult {
    return {
      ok: false,
      error: message,
      output: JSON.stringify({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode,
      }, null, 2),
    };
  }

  private async executeCommandTool(
    request: BrokerExecutionRequest,
    resolvedSecrets: ResolvedSecretsBundle,
  ): Promise<BrokerExecutionResult> {
    if (request.tool.execution.backend !== "command") {
      return { ok: false, error: "Invalid command backend configuration." };
    }

    const inputObject = this.getInputObject(request.input);
    const args = this.buildCommandArgs(request.tool, inputObject, resolvedSecrets.values);
    const env = {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(request.tool.execution.env ?? {}).map(([key, value]) => [key, this.renderTemplate(value, inputObject, resolvedSecrets.values)]),
      ),
      ...resolvedSecrets.env,
    } as Record<string, string>;
    const cwd = this.resolveCommandCwd(request.skill, request.tool, inputObject, resolvedSecrets.values);

    try {
      const result = await execFileAsync(request.tool.execution.command, args, {
        timeout: request.tool.policy.timeoutMs ?? request.skill.policy.timeoutMs ?? 30_000,
        env,
        cwd,
        maxBuffer: 2 * 1024 * 1024,
      });
      return this.formatCommandSuccess(request.tool.execution.outputMode, result.stdout, result.stderr);
    } catch (err) {
      const details = err as ExecErrorWithOutput;
      const exitCode = typeof details.code === "number" ? details.code : null;
      const message = details instanceof Error ? details.message : String(details);
      return this.formatCommandFailure(
        `External command execution failed: ${message}`,
        details.stdout ?? "",
        details.stderr ?? "",
        exitCode,
      );
    }
  }

  private isAllowedHttpDomain(hostname: string, allowedDomains: string[]): boolean {
    return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  }

  private async executeHttpTool(
    request: BrokerExecutionRequest,
    resolvedSecrets: ResolvedSecretsBundle,
  ): Promise<BrokerExecutionResult> {
    if (request.tool.execution.backend !== "http") {
      return { ok: false, error: "Invalid http backend configuration." };
    }

    const inputObject = this.getInputObject(request.input);
    const url = this.renderTemplate(request.tool.execution.url, inputObject, resolvedSecrets.values);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (err) {
      return { ok: false, error: `External HTTP execution failed: invalid URL (${err instanceof Error ? err.message : String(err)})` };
    }

    const allowedDomains = normalizeStringArray(request.tool.execution.allowedDomains);
    if (allowedDomains.length === 0 || !this.isAllowedHttpDomain(parsedUrl.hostname, allowedDomains)) {
      return { ok: false, error: `External HTTP execution blocked: ${parsedUrl.hostname} is not in the allowed domain list.` };
    }

    const controller = new AbortController();
    const timeoutMs = request.tool.policy.timeoutMs ?? request.skill.policy.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = Object.fromEntries(
        Object.entries(request.tool.execution.headers ?? {}).map(([key, value]) => [key, this.renderTemplate(value, inputObject, resolvedSecrets.values)]),
      );
      const renderedBody = typeof request.tool.execution.bodyTemplate === "string"
        ? this.renderTemplate(request.tool.execution.bodyTemplate, inputObject, resolvedSecrets.values)
        : request.tool.execution.bodyTemplate
          ? JSON.stringify(this.renderStructuredTemplateValue(request.tool.execution.bodyTemplate, inputObject, resolvedSecrets.values))
          : undefined;
      const response = await fetch(url, {
        method: request.tool.execution.method ?? "GET",
        headers,
        body: renderedBody,
        signal: controller.signal,
      });
      const body = await response.text();
      return {
        ok: response.ok,
        output: JSON.stringify({ status: response.status, body }, null, 2),
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (err) {
      return { ok: false, error: `External HTTP execution failed: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeNodeAdapter(
    request: BrokerExecutionRequest,
    resolvedSecrets: ResolvedSecretsBundle,
  ): Promise<BrokerExecutionResult> {
    if (!request.skill.adapterPath) {
      return { ok: false, error: `No adapter path configured for ${request.skill.id}.` };
    }
    if (request.tool.execution.backend !== "node") {
      return { ok: false, error: "Invalid node backend configuration." };
    }

    const module = await import(resolve(request.skill.adapterPath)) as SkillAdapterModule;
    const handler = module[request.tool.execution.handler];
    if (typeof handler !== "function") {
      return { ok: false, error: `Adapter handler "${request.tool.execution.handler}" was not found for ${request.skill.id}.` };
    }

    const adapterContext: SkillAdapterContext = {
      secrets: this.secrets,
      command: {
        run: async (input) => {
          try {
            const result = await execFileAsync(input.command, input.args ?? [], {
              timeout: input.timeoutMs ?? 30_000,
              env: {
                ...process.env,
                ...(input.env ?? {}),
                ...resolvedSecrets.env,
              } as Record<string, string>,
              cwd: dirname(request.skill.adapterPath!),
              maxBuffer: 2 * 1024 * 1024,
            });
            return {
              ok: true,
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: 0,
            };
          } catch (err) {
            const details = err as ExecErrorWithOutput;
            return {
              ok: false,
              stdout: details.stdout ?? "",
              stderr: details.stderr ?? "",
              exitCode: typeof details.code === "number" ? details.code : null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      },
      http: {
        request: async (input) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 30_000);
          try {
            const response = await fetch(input.url, {
              method: input.method,
              headers: input.headers,
              body: input.body,
              signal: controller.signal,
            });
            return {
              ok: response.ok,
              status: response.status,
              body: await response.text(),
              ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
            };
          } catch (err) {
            return { ok: false, status: 0, body: "", error: err instanceof Error ? err.message : String(err) };
          } finally {
            clearTimeout(timeout);
          }
        },
      },
      logger: {
        info: () => undefined,
        warn: () => undefined,
      },
    };

    return handler(adapterContext, request);
  }

  private redactExecutionResult(
    result: BrokerExecutionResult,
    tool: NormalizedExternalTool,
    secretValues: string[],
  ): BrokerExecutionResult {
    const redactedFields = tool.policy.redactedFields ?? [];
    return {
      ...result,
      ...(typeof result.output === "string" ? { output: this.redactText(result.output, secretValues, redactedFields) } : {}),
      ...(typeof result.error === "string" ? { error: this.redactText(result.error, secretValues, redactedFields) } : {}),
      ...(result.meta ? { meta: this.redactUnknown(result.meta, secretValues, redactedFields) as Record<string, unknown> } : {}),
    };
  }

  private redactUnknown(value: unknown, secretValues: string[], redactedFields: string[]): unknown {
    if (typeof value === "string") {
      return this.redactText(value, secretValues, redactedFields);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.redactUnknown(item, secretValues, redactedFields));
    }
    if (!isPlainObject(value)) {
      return value;
    }

    const fieldSet = new Set(redactedFields);
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => {
        if (fieldSet.has(key)) {
          return [key, "[REDACTED]"];
        }
        return [key, this.redactUnknown(nestedValue, secretValues, redactedFields)];
      }),
    );
  }

  private redactText(text: string, secretValues: string[], redactedFields: string[]): string {
    let redacted = text;

    for (const secret of [...new Set(secretValues)].sort((left, right) => right.length - left.length)) {
      if (secret.length === 0) {
        continue;
      }
      redacted = redacted.split(secret).join("[REDACTED]");
    }

    if (redactedFields.length === 0) {
      return redacted;
    }

    try {
      const parsed = JSON.parse(redacted);
      return JSON.stringify(this.redactUnknown(parsed, [], redactedFields), null, 2);
    } catch {
      return redacted;
    }
  }

  private pruneUnmountedWindowEntries(context?: ToolExecutionContext): void {
    const mountedGroupIds = new Set((this.options.toolExecutor.listMountedGroups?.(context) ?? []).map((group) => group.groupId));
    for (const [groupId, entry] of this.windowEntries.entries()) {
      if (!this.matchesContext(entry, context)) {
        continue;
      }
      if (!mountedGroupIds.has(groupId)) {
        this.windowEntries.delete(groupId);
      }
    }
  }

  private getWindowEntriesForContext(context?: ToolExecutionContext): ExternalToolWindowEntry[] {
    return [...this.windowEntries.values()].filter((entry) => this.matchesContext(entry, context));
  }

  private matchesContext(entry: ExternalToolWindowEntry, context?: ToolExecutionContext): boolean {
    if (context?.runId && entry.runId && entry.runId !== context.runId) {
      return false;
    }
    if (context?.sessionId && entry.sessionId && entry.sessionId !== context.sessionId) {
      return false;
    }
    if (context?.clientId) {
      return true;
    }
    return true;
  }

  private touchWindowEntry(toolName: string, context?: ToolExecutionContext): void {
    const entry = this.getWindowEntriesForContext(context).find((candidate) => candidate.toolName === toolName);
    if (!entry) {
      return;
    }

    if (typeof context?.stepNumber === "number") {
      entry.lastTouchedAtStep = context.stepNumber;
    }
  }

  private getActiveSkillGroups(context?: ToolExecutionContext): Array<{
    skill: NormalizedExternalSkill;
    entries: ExternalToolWindowEntry[];
    order: number;
  }> {
    const bySkill = new Map<string, ExternalToolWindowEntry[]>();
    for (const entry of this.getWindowEntriesForContext(context)) {
      const bucket = bySkill.get(entry.skillId) ?? [];
      bucket.push(entry);
      bySkill.set(entry.skillId, bucket);
    }

    return [...bySkill.entries()]
      .map(([skillId, entries]) => {
        const skill = getExternalSkillById(this.catalog, skillId);
        if (!skill) {
          return null;
        }
        const sortedEntries = [...entries].sort((left, right) => left.order - right.order || left.toolName.localeCompare(right.toolName));
        return {
          skill,
          entries: sortedEntries,
          order: sortedEntries[0]?.order ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .filter((group): group is {
        skill: NormalizedExternalSkill;
        entries: ExternalToolWindowEntry[];
        order: number;
      } => group !== null)
      .sort((left, right) => left.order - right.order || left.skill.id.localeCompare(right.skill.id));
  }

  private unmountToolByName(toolName: string, context?: ToolExecutionContext): void {
    const entry = this.getWindowEntriesForContext(context).find((candidate) => candidate.toolName === toolName);
    if (!entry) {
      return;
    }
    this.options.toolExecutor.unmount?.(entry.groupId);
    this.windowEntries.delete(entry.groupId);
  }

  private buildGroupId(context: ToolExecutionContext | undefined, toolName: string): string {
    return `external:${context?.sessionId ?? "session"}:${context?.runId ?? "run"}:${toolName}`;
  }

  private cloneWindowEntry(entry: ExternalToolWindowEntry): ExternalToolWindowEntry {
    return { ...entry };
  }
}

export function createExternalSkillBroker(options: ExternalSkillBrokerOptions): ExternalSkillBroker {
  return new ExternalSkillBroker(options);
}
