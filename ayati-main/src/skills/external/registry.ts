import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition, ToolExecutionContext, ToolResult, ToolSelectionHints } from "../types.js";
import type {
  ExternalCommandArgSpec,
  ExternalCommandOutputMode,
  ExternalDependencyCheck,
  ExternalExecutionPolicy,
  ExternalExecutionSpec,
  ExternalSkillScanRoot,
  ExternalToolManifest,
  SecretRefConfig,
  StructuredSkillManifest,
} from "./types.js";
import { inferSource, normalizeScanRoots, tryExec } from "./scanner.js";
import { buildExternalToolDescription, validatePortableToolInputSchema } from "./tool-schema.js";
import { devWarn } from "../../shared/index.js";

const execFileAsync = promisify(execFile);
const TOOL_MANIFEST_EXTENSION = ".json";

interface SecretMappingEntry {
  source?: "env";
  env?: string;
}

interface SkillPolicyConfig {
  defaultMode?: "allow" | "ask" | "deny";
  capabilities?: Record<string, "allow" | "ask" | "deny">;
}

interface ResolvedSecret {
  ok: boolean;
  ref: string;
  value?: string;
  env?: Record<string, string>;
  error?: string;
}

interface LoadedSecretsBundle {
  env: Record<string, string>;
  values: Record<string, string>;
  valueList: string[];
}

interface ExternalSkillRecord {
  id: string;
  title: string;
  description: string;
  cardSummary: string;
  cardWhenToUse: string;
  roleLabel?: string;
  useFor: string[];
  notFor: string[];
  workflowHint?: string;
  pairedSkillId?: string;
  constraints: string[];
  skillDir: string;
  manifestPath: string;
  source: string;
  domains: string[];
  tags: string[];
  aliases: string[];
  triggers: string[];
  auth: SecretRefConfig;
  policy: ExternalExecutionPolicy;
  tools: ExternalToolRecord[];
}

interface ExternalToolRecord {
  skill: ExternalSkillRecord;
  toolId: string;
  toolName: string;
  title: string;
  description: string;
  aliases: string[];
  tags: string[];
  triggers: string[];
  action?: string;
  object?: string;
  provider?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  execution: ExternalExecutionSpec;
  auth: SecretRefConfig;
  policy: ExternalExecutionPolicy;
  definition: ToolDefinition;
}

export interface QuarantinedExternalSkill {
  skillId: string;
  reason: string;
  manifestPath?: string;
}

export interface ExternalToolSearchResult {
  skillId: string;
  toolId: string;
  toolName: string;
  title: string;
  description: string;
  matchReasons: string[];
  domains: string[];
  tags: string[];
  inputSchema?: Record<string, unknown>;
  definition: ToolDefinition;
}

export interface ExternalSkillCard {
  skillId: string;
  title: string;
  summary: string;
  whenToUse: string;
  roleLabel?: string;
  useFor: string[];
  notFor: string[];
  workflowHint?: string;
  pairedSkillId?: string;
  toolCount: number;
  toolsPreview: ExternalSkillToolSummary[];
  previewTruncated: boolean;
  domains: string[];
  tags: string[];
}

export interface ExternalSkillToolSummary {
  toolId: string;
  toolName: string;
  title: string;
  description: string;
  inputSummary: string;
}

export interface ExternalSkillDetail {
  skillId: string;
  title: string;
  description: string;
  summary: string;
  whenToUse: string;
  roleLabel?: string;
  useFor: string[];
  notFor: string[];
  workflowHint?: string;
  pairedSkillId?: string;
  toolCount: number;
  domains: string[];
  tags: string[];
  aliases: string[];
  triggers: string[];
  constraints: string[];
  tools: ExternalSkillToolSummary[];
}

export interface ExternalSkillSearchResult {
  skillId: string;
  title: string;
  summary: string;
  whenToUse: string;
  roleLabel?: string;
  workflowHint?: string;
  pairedSkillId?: string;
  toolCount: number;
  matchReasons: string[];
  domains: string[];
  tags: string[];
}

export interface ExternalSkillRegistryOptions {
  roots: Array<string | ExternalSkillScanRoot>;
  secretMappingPath: string;
  policyPath: string;
}

interface ExecErrorWithOutput extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
}

const SYNONYM_MAP: Record<string, string[]> = {
  mail: ["email", "gmail", "message", "thread", "inbox"],
  email: ["mail", "gmail", "message", "thread", "inbox"],
  github: ["gh", "pull", "review", "repo"],
  web: ["browser", "search", "page"],
  browser: ["web", "page", "agent-browser", "playwright"],
  search: ["websearch", "google", "lookup"],
};

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

function normalizeSecretConfig(value: SecretRefConfig | undefined): SecretRefConfig {
  return {
    ...(typeof value?.required === "boolean" ? { required: value.required } : {}),
    secretRefs: normalizeStringArray(value?.secretRefs),
  };
}

function normalizePolicy(value: ExternalExecutionPolicy | undefined): ExternalExecutionPolicy {
  return {
    capabilities: normalizeStringArray(value?.capabilities),
    ...(value?.defaultMode ? { defaultMode: value.defaultMode } : {}),
    ...(typeof value?.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
    ...(value?.retryPolicy ? { retryPolicy: value.retryPolicy } : {}),
    redactedFields: normalizeStringArray(value?.redactedFields),
  };
}

function normalizeCommandArgs(value: unknown): ExternalCommandArgSpec[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item))
    .map((item) => ({
      ...(normalizeOptionalString(item["flag"]) ? { flag: normalizeOptionalString(item["flag"]) } : {}),
      ...(normalizeOptionalString(item["value"]) ? { value: normalizeOptionalString(item["value"]) } : {}),
      ...(normalizeOptionalString(item["from"]) ? { from: normalizeOptionalString(item["from"]) } : {}),
      ...(normalizeOptionalString(item["joinWith"]) ? { joinWith: normalizeOptionalString(item["joinWith"]) } : {}),
      ...(typeof item["repeat"] === "boolean" ? { repeat: item["repeat"] } : {}),
    }));
}

function normalizeExecutionSpec(value: ExternalExecutionSpec | undefined): ExternalExecutionSpec | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  if (value.backend === "command" || value.backend === "shell") {
    const command = normalizeOptionalString(value.command);
    if (!command) {
      return null;
    }
    return {
      backend: value.backend,
      command,
      argsTemplate: Array.isArray(value.argsTemplate) ? value.argsTemplate.filter((item): item is string => typeof item === "string") : undefined,
      args: normalizeCommandArgs((value as Record<string, unknown>)["args"]),
      ...(normalizeOptionalString((value as Record<string, unknown>)["cwdTemplate"]) ? { cwdTemplate: normalizeOptionalString((value as Record<string, unknown>)["cwdTemplate"]) } : {}),
      env: value.env && typeof value.env === "object" && !Array.isArray(value.env)
        ? Object.fromEntries(
          Object.entries(value.env)
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
        )
        : undefined,
      ...(normalizeOptionalString((value as Record<string, unknown>)["outputMode"]) ? { outputMode: normalizeOptionalString((value as Record<string, unknown>)["outputMode"]) as ExternalCommandOutputMode } : {}),
    };
  }

  if (value.backend === "http" || value.backend === "curl") {
    const url = normalizeOptionalString((value as { url?: string }).url);
    if (!url) {
      return null;
    }
    return {
      backend: value.backend,
      ...(value.method ? { method: value.method } : {}),
      url,
      headers: value.headers && typeof value.headers === "object" && !Array.isArray(value.headers)
        ? Object.fromEntries(
          Object.entries(value.headers)
            .filter((entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"),
        )
        : undefined,
      ...(typeof value.bodyTemplate === "string" || Array.isArray(value.bodyTemplate) || (value.bodyTemplate && typeof value.bodyTemplate === "object")
        ? { bodyTemplate: value.bodyTemplate }
        : {}),
      allowedDomains: normalizeStringArray((value as { allowedDomains?: unknown }).allowedDomains),
    };
  }

  if (value.backend === "node") {
    const handler = normalizeOptionalString((value as { handler?: string }).handler);
    if (!handler) {
      return null;
    }
    return {
      backend: "node",
      handler,
    };
  }

  return value;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function expandTokens(tokens: string[]): string[] {
  const expanded = new Set<string>(tokens);
  for (const token of tokens) {
    for (const synonym of SYNONYM_MAP[token] ?? []) {
      expanded.add(synonym);
    }
  }
  return [...expanded];
}

function buildSearchCorpus(tool: ExternalToolRecord): string[] {
  return [
    tool.toolName,
    tool.skill.id,
    tool.skill.title,
    tool.skill.description,
    tool.skill.cardSummary,
    tool.skill.cardWhenToUse,
    tool.skill.roleLabel ?? "",
    ...tool.skill.useFor,
    tool.skill.workflowHint ?? "",
    ...tool.skill.domains,
    ...tool.skill.tags,
    ...tool.skill.aliases,
    ...tool.skill.triggers,
    tool.toolId,
    tool.title,
    tool.description,
    ...tool.aliases,
    ...tool.tags,
    ...tool.triggers,
    tool.action ?? "",
    tool.object ?? "",
    tool.provider ?? "",
  ].filter((value) => value.trim().length > 0);
}

function buildSkillSearchCorpus(skill: ExternalSkillRecord): string[] {
  return [
    skill.id,
    skill.title,
    skill.description,
    skill.cardSummary,
    skill.cardWhenToUse,
    skill.roleLabel ?? "",
    ...skill.useFor,
    skill.workflowHint ?? "",
    skill.pairedSkillId ?? "",
    ...skill.domains,
    ...skill.tags,
    ...skill.aliases,
    ...skill.triggers,
    ...skill.tools.flatMap((tool) => [
      tool.toolId,
      tool.toolName,
      tool.title,
      tool.description,
      ...tool.aliases,
      ...tool.tags,
      ...tool.triggers,
      tool.action ?? "",
      tool.object ?? "",
      tool.provider ?? "",
    ]),
  ].filter((value) => value.trim().length > 0);
}

function metadataContainsToken(entries: string[], token: string): boolean {
  return entries.some((entry) => tokenize(entry).includes(token));
}

function scoreSearch(tool: ExternalToolRecord, query: string, tokens: string[]): { score: number; reasons: string[] } | null {
  const corpus = buildSearchCorpus(tool).map((value) => value.toLowerCase());
  let score = 0;
  const reasons: string[] = [];

  if (tool.toolName.toLowerCase() === query) {
    score += 50;
    reasons.push("matched tool name");
  }

  for (const token of tokens) {
    if (tool.toolName.toLowerCase().startsWith(token)) {
      score += 24;
      reasons.push("matched tool name");
      continue;
    }
    if (tool.aliases.some((alias) => alias.toLowerCase() === token) || tool.skill.aliases.some((alias) => alias.toLowerCase() === token)) {
      score += 18;
      reasons.push("matched alias");
      continue;
    }
    if (tool.tags.some((tag) => tag.toLowerCase() === token) || tool.skill.tags.some((tag) => tag.toLowerCase() === token)) {
      score += 12;
      reasons.push("matched tag");
      continue;
    }
    if (metadataContainsToken(tool.skill.useFor, token) || metadataContainsToken([tool.skill.roleLabel ?? "", tool.skill.workflowHint ?? ""], token)) {
      score += 10;
      reasons.push("matched guidance");
      continue;
    }
    if (tool.skill.domains.some((domain) => domain.toLowerCase() === token)) {
      score += 12;
      reasons.push("matched domain");
      continue;
    }
    if (metadataContainsToken(tool.skill.notFor, token)) {
      score -= 8;
      continue;
    }
    if (corpus.some((entry) => entry.includes(token))) {
      score += 6;
      reasons.push("matched phrase");
    }
  }

  return score > 0 ? { score, reasons: [...new Set(reasons)].slice(0, 4) } : null;
}

function scoreSkillSearch(skill: ExternalSkillRecord, query: string, tokens: string[]): { score: number; reasons: string[] } | null {
  const corpus = buildSkillSearchCorpus(skill).map((value) => value.toLowerCase());
  let score = 0;
  const reasons: string[] = [];

  if (skill.id.toLowerCase() === query || skill.title.toLowerCase() === query) {
    score += 50;
    reasons.push("matched skill name");
  }

  for (const token of tokens) {
    if (skill.id.toLowerCase().startsWith(token) || skill.title.toLowerCase().startsWith(token)) {
      score += 24;
      reasons.push("matched skill name");
      continue;
    }
    if (skill.aliases.some((alias) => alias.toLowerCase() === token)) {
      score += 18;
      reasons.push("matched alias");
      continue;
    }
    if (metadataContainsToken([skill.roleLabel ?? ""], token)) {
      score += 18;
      reasons.push("matched role");
      continue;
    }
    if (skill.tags.some((tag) => tag.toLowerCase() === token)) {
      score += 12;
      reasons.push("matched tag");
      continue;
    }
    if (skill.domains.some((domain) => domain.toLowerCase() === token)) {
      score += 12;
      reasons.push("matched domain");
      continue;
    }
    if (metadataContainsToken(skill.useFor, token) || metadataContainsToken([skill.workflowHint ?? ""], token)) {
      score += 10;
      reasons.push("matched guidance");
      continue;
    }
    if (metadataContainsToken(skill.notFor, token)) {
      score -= 8;
      continue;
    }
    if (corpus.some((entry) => entry.includes(token))) {
      score += 6;
      reasons.push("matched phrase");
    }
  }

  return score > 0 ? { score, reasons: [...new Set(reasons)].slice(0, 4) } : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonFile<T>(pathValue: string): Promise<T> {
  const raw = await readFile(pathValue, "utf-8");
  return JSON.parse(raw) as T;
}

function stringifyCommandValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function buildInputSummary(inputSchema: Record<string, unknown> | undefined): string {
  if (!inputSchema) {
    return "Parameters: none";
  }

  const properties = isPlainObject(inputSchema["properties"])
    ? inputSchema["properties"] as Record<string, { type?: string; description?: string }>
    : {};
  const required = Array.isArray(inputSchema["required"])
    ? (inputSchema["required"] as unknown[]).map(String)
    : [];

  const entries = Object.entries(properties)
    .slice(0, 4)
    .map(([name, property]) => {
      const type = typeof property?.type === "string" ? property.type : "any";
      const requirement = required.includes(name) ? "required" : "optional";
      return `${name}: ${type} (${requirement})`;
    });

  if (entries.length === 0) {
    return "Parameters: none";
  }

  return `Parameters: ${entries.join(", ")}`;
}

function buildCardSummary(manifest: StructuredSkillManifest, description: string): string {
  return normalizeOptionalString(manifest.card?.summary) ?? description;
}

function buildCardWhenToUse(manifest: StructuredSkillManifest): string {
  const explicit = normalizeOptionalString(manifest.card?.whenToUse);
  if (explicit) {
    return explicit;
  }

  const triggers = normalizeStringArray(manifest.triggers);
  if (triggers.length > 0) {
    return triggers.slice(0, 3).join("; ");
  }

  const domains = normalizeStringArray(manifest.domains);
  if (domains.length > 0) {
    return `Use when the task needs ${domains.join(", ")} capabilities.`;
  }

  return "Use when this capability clearly matches the task.";
}

function buildRoleLabel(manifest: StructuredSkillManifest): string | undefined {
  return normalizeOptionalString(manifest.card?.roleLabel);
}

function buildUseFor(manifest: StructuredSkillManifest): string[] {
  return normalizeStringArray(manifest.card?.useFor);
}

function buildNotFor(manifest: StructuredSkillManifest): string[] {
  return normalizeStringArray(manifest.card?.notFor);
}

function buildWorkflowHint(manifest: StructuredSkillManifest): string | undefined {
  return normalizeOptionalString(manifest.card?.workflowHint);
}

function buildPairedSkillId(manifest: StructuredSkillManifest): string | undefined {
  return normalizeOptionalString(manifest.card?.pairedSkillId);
}

function buildSkillConstraints(
  auth: SecretRefConfig,
  policy: ExternalExecutionPolicy,
): string[] {
  const constraints: string[] = [];

  if (auth.required || (auth.secretRefs?.length ?? 0) > 0) {
    constraints.push("Requires runtime-managed credentials.");
  }
  if (typeof policy.timeoutMs === "number" && policy.timeoutMs > 0) {
    constraints.push(`Execution timeout: ${policy.timeoutMs}ms.`);
  }
  if ((policy.capabilities?.length ?? 0) > 0) {
    constraints.push(`Capabilities: ${(policy.capabilities ?? []).join(", ")}.`);
  }

  return constraints;
}

class MappedSecretResolver {
  private readonly mappingPath: string;
  private mapping = new Map<string, SecretMappingEntry>();

  constructor(mappingPath: string) {
    this.mappingPath = mappingPath;
  }

  async initialize(): Promise<void> {
    this.mapping.clear();
    let parsed: Record<string, SecretMappingEntry> = {};
    try {
      parsed = await readJsonFile<Record<string, SecretMappingEntry>>(this.mappingPath);
    } catch {
      parsed = {};
    }

    for (const [ref, entry] of Object.entries(parsed)) {
      this.mapping.set(ref, entry);
    }
  }

  async resolve(ref: string): Promise<ResolvedSecret> {
    const entry = this.mapping.get(ref);
    if (!entry?.env) {
      return { ok: false, ref, error: `No secret mapping configured for ${ref}` };
    }
    const value = process.env[entry.env];
    if (!value) {
      return { ok: false, ref, error: `Missing environment variable ${entry.env}` };
    }
    return {
      ok: true,
      ref,
      value,
      env: { [entry.env]: value },
    };
  }
}

export class ExternalSkillRegistry {
  private readonly options: ExternalSkillRegistryOptions;
  private readonly secretResolver: MappedSecretResolver;
  private capabilityPolicy: SkillPolicyConfig = { defaultMode: "allow", capabilities: {} };
  private readonly skillRecords = new Map<string, ExternalSkillRecord>();
  private readonly toolRecords = new Map<string, ExternalToolRecord>();
  private readonly quarantinedSkills = new Map<string, QuarantinedExternalSkill>();

  constructor(options: ExternalSkillRegistryOptions) {
    this.options = options;
    this.secretResolver = new MappedSecretResolver(options.secretMappingPath);
  }

  async initialize(): Promise<void> {
    this.skillRecords.clear();
    this.toolRecords.clear();
    this.quarantinedSkills.clear();
    await this.secretResolver.initialize();
    this.capabilityPolicy = await this.loadPolicy();

    for (const root of normalizeScanRoots(this.options.roots)) {
      const entries = await readdir(root.skillsDir).catch(() => []);
      for (const entry of entries.sort()) {
        const skillDir = join(root.skillsDir, entry);
        const entryStat = await stat(skillDir).catch(() => null);
        if (!entryStat?.isDirectory()) {
          continue;
        }
        await this.loadSkillDirectory(skillDir, inferSource(root));
      }
    }
  }

  hasTool(toolName: string): boolean {
    return this.toolRecords.has(toolName);
  }

  getSkillCards(): ExternalSkillCard[] {
    return [...this.skillRecords.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((skill) => this.toSkillCard(skill));
  }

  getSkillDetail(skillId: string): ExternalSkillDetail | undefined {
    const skill = this.skillRecords.get(skillId);
    return skill ? this.toSkillDetail(skill) : undefined;
  }

  getToolDefinition(toolName: string): ToolDefinition | undefined {
    return this.toolRecords.get(toolName)?.definition;
  }

  getToolSummary(toolName: string): ExternalSkillToolSummary | undefined {
    const tool = this.toolRecords.get(toolName);
    if (!tool) {
      return undefined;
    }
    return this.toToolSummary(tool);
  }

  resolveSkillToolNames(skillId: string, requestedToolNames: string[]): { resolved: string[]; missing: string[] } {
    const skill = this.skillRecords.get(skillId);
    if (!skill) {
      return { resolved: [], missing: [...new Set(requestedToolNames.map((value) => value.trim()).filter((value) => value.length > 0))] };
    }

    const byToolId = new Map(skill.tools.map((tool) => [tool.toolId, tool.toolName]));
    const byToolName = new Map(skill.tools.map((tool) => [tool.toolName, tool.toolName]));
    const resolved: string[] = [];
    const missing: string[] = [];

    for (const requestedName of requestedToolNames) {
      const normalized = requestedName.trim();
      if (!normalized) {
        continue;
      }
      const toolName = byToolName.get(normalized) ?? byToolId.get(normalized);
      if (toolName) {
        if (!resolved.includes(toolName)) {
          resolved.push(toolName);
        }
        continue;
      }
      if (!missing.includes(normalized)) {
        missing.push(normalized);
      }
    }

    return { resolved, missing };
  }

  getQuarantinedSkills(): QuarantinedExternalSkill[] {
    return [...this.quarantinedSkills.values()];
  }

  searchSkills(query: string, limit = 5): ExternalSkillSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const tokens = expandTokens(tokenize(query));
    return [...this.skillRecords.values()]
      .map((skill) => {
        const scored = scoreSkillSearch(skill, normalizedQuery, tokens);
        return scored ? { skill, ...scored } : null;
      })
      .filter((entry): entry is { skill: ExternalSkillRecord; score: number; reasons: string[] } => entry !== null)
      .sort((left, right) => right.score - left.score || left.skill.id.localeCompare(right.skill.id))
      .slice(0, Math.max(1, limit))
      .map(({ skill, reasons }) => ({
        skillId: skill.id,
        title: skill.title,
        summary: skill.cardSummary,
        whenToUse: skill.cardWhenToUse,
        ...(skill.roleLabel ? { roleLabel: skill.roleLabel } : {}),
        ...(skill.workflowHint ? { workflowHint: skill.workflowHint } : {}),
        ...(skill.pairedSkillId ? { pairedSkillId: skill.pairedSkillId } : {}),
        toolCount: skill.tools.length,
        matchReasons: reasons,
        domains: [...skill.domains],
        tags: [...skill.tags],
      }));
  }

  search(query: string, limit = 5): ExternalToolSearchResult[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return [];
    }

    const tokens = expandTokens(tokenize(query));
    return [...this.toolRecords.values()]
      .map((tool) => {
        const scored = scoreSearch(tool, normalizedQuery, tokens);
        return scored ? { tool, ...scored } : null;
      })
      .filter((entry): entry is { tool: ExternalToolRecord; score: number; reasons: string[] } => entry !== null)
      .sort((left, right) => right.score - left.score || left.tool.toolName.localeCompare(right.tool.toolName))
      .slice(0, Math.max(1, limit))
      .map(({ tool, reasons }) => ({
        skillId: tool.skill.id,
        toolId: tool.toolId,
        toolName: tool.toolName,
        title: tool.title,
        description: tool.description,
        matchReasons: reasons,
        domains: [...tool.skill.domains],
        tags: [...tool.tags],
        ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
        definition: tool.definition,
      }));
  }

  private toSkillCard(skill: ExternalSkillRecord): ExternalSkillCard {
    const sortedTools = [...skill.tools]
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
    const toolsPreview = sortedTools
      .slice(0, 3)
      .map((tool) => this.toToolSummary(tool));

    return {
      skillId: skill.id,
      title: skill.title,
      summary: skill.cardSummary,
      whenToUse: skill.cardWhenToUse,
      ...(skill.roleLabel ? { roleLabel: skill.roleLabel } : {}),
      useFor: [...skill.useFor],
      notFor: [...skill.notFor],
      ...(skill.workflowHint ? { workflowHint: skill.workflowHint } : {}),
      ...(skill.pairedSkillId ? { pairedSkillId: skill.pairedSkillId } : {}),
      toolCount: skill.tools.length,
      toolsPreview,
      previewTruncated: sortedTools.length > toolsPreview.length,
      domains: [...skill.domains],
      tags: [...skill.tags],
    };
  }

  private toToolSummary(tool: ExternalToolRecord): ExternalSkillToolSummary {
    return {
      toolId: tool.toolId,
      toolName: tool.toolName,
      title: tool.title,
      description: tool.description,
      inputSummary: buildInputSummary(tool.inputSchema),
    };
  }

  private toSkillDetail(skill: ExternalSkillRecord): ExternalSkillDetail {
    return {
      skillId: skill.id,
      title: skill.title,
      description: skill.description,
      summary: skill.cardSummary,
      whenToUse: skill.cardWhenToUse,
      ...(skill.roleLabel ? { roleLabel: skill.roleLabel } : {}),
      useFor: [...skill.useFor],
      notFor: [...skill.notFor],
      ...(skill.workflowHint ? { workflowHint: skill.workflowHint } : {}),
      ...(skill.pairedSkillId ? { pairedSkillId: skill.pairedSkillId } : {}),
      toolCount: skill.tools.length,
      domains: [...skill.domains],
      tags: [...skill.tags],
      aliases: [...skill.aliases],
      triggers: [...skill.triggers],
      constraints: [...skill.constraints],
      tools: skill.tools
        .map((tool) => this.toToolSummary(tool))
        .sort((left, right) => left.toolName.localeCompare(right.toolName)),
    };
  }

  private async loadPolicy(): Promise<SkillPolicyConfig> {
    try {
      return await readJsonFile<SkillPolicyConfig>(this.options.policyPath);
    } catch {
      return { defaultMode: "allow", capabilities: {} };
    }
  }

  private async loadSkillDirectory(skillDir: string, source: string): Promise<void> {
    const manifestPath = join(skillDir, "skill.json");
    let manifest: StructuredSkillManifest;
    try {
      manifest = await readJsonFile<StructuredSkillManifest>(manifestPath);
    } catch (error) {
      const skillId = skillDir.split("/").pop() ?? skillDir;
      this.quarantine(skillId, `Failed to parse skill.json: ${error instanceof Error ? error.message : String(error)}`, manifestPath);
      return;
    }

    const skillId = normalizeOptionalString(manifest.id);
    const description = normalizeOptionalString(manifest.description);
    if (!skillId || !description) {
      this.quarantine(skillId ?? skillDir.split("/").pop() ?? skillDir, "skill.json is missing id or description", manifestPath);
      return;
    }

    if (manifest.status !== "active") {
      return;
    }

    if (!normalizeOptionalString(manifest.card?.summary) || !normalizeOptionalString(manifest.card?.whenToUse)) {
      this.quarantine(skillId, "skill.json must define card.summary and card.whenToUse for active skills", manifestPath);
      return;
    }
    if (!normalizeOptionalString(manifest.activation?.brief)) {
      this.quarantine(skillId, "skill.json must define activation.brief for active skills", manifestPath);
      return;
    }

    const dependencyChecks = Array.isArray(manifest.dependencies?.checks) ? manifest.dependencies?.checks : [];
    const dependencyOk = await this.runDependencyChecks(dependencyChecks ?? []);
    if (!dependencyOk) {
      this.quarantine(skillId, "Dependency checks failed at startup", manifestPath);
      return;
    }

    const skillPolicy = normalizePolicy(manifest.policy);
    const capabilityBlock = this.validateCapabilityPolicy(skillPolicy.capabilities ?? []);
    if (!capabilityBlock.ok) {
      this.quarantine(skillId, capabilityBlock.error ?? "Capability policy blocked skill", manifestPath);
      return;
    }

    const toolFiles = Array.isArray(manifest.toolFiles) && manifest.toolFiles.length > 0
      ? [...manifest.toolFiles]
      : (await readdir(join(skillDir, "tools")).catch(() => []))
        .filter((entry) => entry.endsWith(TOOL_MANIFEST_EXTENSION))
        .map((entry) => join("tools", entry));
    if (toolFiles.length === 0) {
      this.quarantine(skillId, "No typed tool manifests were found for this skill", manifestPath);
      return;
    }

    const skillRecord: ExternalSkillRecord = {
      id: skillId,
      title: normalizeOptionalString(manifest.title) ?? skillId,
      description,
      cardSummary: buildCardSummary(manifest, description),
      cardWhenToUse: buildCardWhenToUse(manifest),
      roleLabel: buildRoleLabel(manifest),
      useFor: buildUseFor(manifest),
      notFor: buildNotFor(manifest),
      workflowHint: buildWorkflowHint(manifest),
      pairedSkillId: buildPairedSkillId(manifest),
      constraints: buildSkillConstraints(normalizeSecretConfig(manifest.auth), skillPolicy),
      skillDir,
      manifestPath,
      source,
      domains: normalizeStringArray(manifest.domains),
      tags: normalizeStringArray(manifest.tags),
      aliases: normalizeStringArray(manifest.aliases),
      triggers: normalizeStringArray(manifest.triggers),
      auth: normalizeSecretConfig(manifest.auth),
      policy: skillPolicy,
      tools: [],
    };

    const toolRecords: ExternalToolRecord[] = [];
    for (const toolFile of toolFiles) {
      const toolPath = join(skillDir, toolFile);
      let manifestTool: ExternalToolManifest;
      try {
        manifestTool = await readJsonFile<ExternalToolManifest>(toolPath);
      } catch (error) {
        this.quarantine(skillId, `Failed to parse tool schema ${toolFile}: ${error instanceof Error ? error.message : String(error)}`, manifestPath);
        return;
      }

      const toolRecord = this.buildToolRecord(skillRecord, manifestTool, toolPath);
      if (!toolRecord.ok || !toolRecord.record) {
        this.quarantine(skillId, toolRecord.error ?? `Invalid tool schema: ${toolFile}`, manifestPath);
        return;
      }
      toolRecords.push(toolRecord.record);
    }

    for (const toolRecord of toolRecords) {
      if (this.toolRecords.has(toolRecord.toolName)) {
        this.quarantine(skillId, `Duplicate external tool name detected: ${toolRecord.toolName}`, manifestPath);
        return;
      }
    }

    if (this.skillRecords.has(skillId)) {
      this.quarantine(skillId, `Duplicate external skill id detected: ${skillId}`, manifestPath);
      return;
    }

    skillRecord.tools = toolRecords;
    this.skillRecords.set(skillId, skillRecord);
    for (const toolRecord of toolRecords) {
      this.toolRecords.set(toolRecord.toolName, toolRecord);
    }
  }

  private buildToolRecord(
    skill: ExternalSkillRecord,
    manifestTool: ExternalToolManifest,
    toolPath: string,
  ): { ok: true; record: ExternalToolRecord } | { ok: false; error: string; record?: undefined } {
    const toolId = normalizeOptionalString(manifestTool.id);
    const description = normalizeOptionalString(manifestTool.description);
    if (!toolId || !description) {
      return { ok: false, error: `${toolPath} is missing id or description` };
    }

    if (manifestTool.inputSchema) {
      const schemaValidation = validatePortableToolInputSchema(manifestTool.inputSchema);
      if (!schemaValidation.ok) {
        return { ok: false, error: `${toolPath} ${schemaValidation.error}` };
      }
    }

    const execution = normalizeExecutionSpec(manifestTool.execution);
    if (!execution) {
      return { ok: false, error: `${toolPath} has an invalid execution block` };
    }

    if (!["shell", "command", "http", "curl", "node"].includes(execution.backend)) {
      return { ok: false, error: `${toolPath} uses unsupported backend "${execution.backend}"` };
    }

    if ((execution.backend === "http" || execution.backend === "curl") && (!execution.allowedDomains || execution.allowedDomains.length === 0)) {
      return { ok: false, error: `${toolPath} must declare allowedDomains for ${execution.backend} execution` };
    }

    const mergedPolicy = normalizePolicy({
      ...skill.policy,
      ...normalizePolicy(manifestTool.policy),
      capabilities: [
        ...(skill.policy.capabilities ?? []),
        ...normalizeStringArray(manifestTool.policy?.capabilities),
      ],
      redactedFields: [
        ...(skill.policy.redactedFields ?? []),
        ...normalizeStringArray(manifestTool.policy?.redactedFields),
      ],
    });
    const capabilityBlock = this.validateCapabilityPolicy(mergedPolicy.capabilities ?? []);
    if (!capabilityBlock.ok) {
      return { ok: false, error: capabilityBlock.error ?? `${toolPath} is blocked by capability policy` };
    }

    const auth = normalizeSecretConfig({
      required: skill.auth.required || manifestTool.auth?.required,
      secretRefs: [
        ...(skill.auth.secretRefs ?? []),
        ...normalizeStringArray(manifestTool.auth?.secretRefs),
      ],
    });

    const toolName = `${skill.id}.${toolId}`;
    const toolDescription = buildExternalToolDescription(description, manifestTool.usage);
    const record = {
      skill,
      toolId,
      toolName,
      title: normalizeOptionalString(manifestTool.title) ?? toolId,
      description: toolDescription,
      aliases: normalizeStringArray(manifestTool.aliases),
      tags: normalizeStringArray(manifestTool.tags),
      triggers: normalizeStringArray(manifestTool.triggers),
      ...(normalizeOptionalString(manifestTool.action) ? { action: normalizeOptionalString(manifestTool.action) } : {}),
      ...(normalizeOptionalString(manifestTool.object) ? { object: normalizeOptionalString(manifestTool.object) } : {}),
      ...(normalizeOptionalString(manifestTool.provider) ? { provider: normalizeOptionalString(manifestTool.provider) } : {}),
      ...(manifestTool.inputSchema ? { inputSchema: manifestTool.inputSchema } : {}),
      ...(manifestTool.outputSchema ? { outputSchema: manifestTool.outputSchema } : {}),
      execution,
      auth,
      policy: mergedPolicy,
      definition: this.buildToolDefinition(skill, toolId, normalizeOptionalString(manifestTool.title) ?? toolId, toolDescription, manifestTool.inputSchema, normalizeStringArray(manifestTool.tags), normalizeStringArray(manifestTool.aliases), normalizeStringArray(manifestTool.triggers)),
    } satisfies ExternalToolRecord;
    return { ok: true, record };
  }

  private buildToolDefinition(
    skill: ExternalSkillRecord,
    toolId: string,
    title: string,
    description: string,
    inputSchema: Record<string, unknown> | undefined,
    tags: string[],
    aliases: string[],
    triggers: string[],
  ): ToolDefinition {
    const toolName = `${skill.id}.${toolId}`;
    const selectionHints: ToolSelectionHints = {
      tags: [...tags],
      aliases: [...aliases],
      examples: [...triggers.slice(0, 5)],
      domain: skill.domains[0] ?? skill.id,
      priority: 25,
    };

    return {
      name: toolName,
      description,
      ...(inputSchema ? { inputSchema } : {}),
      selectionHints,
      execute: async (input, context) => this.executeTool(toolName, input, context),
    };
  }

  private async runDependencyChecks(checks: ExternalDependencyCheck[]): Promise<boolean> {
    for (const check of checks) {
      const command = [check.command, ...(Array.isArray(check.args) ? check.args : [])].join(" ").trim();
      if (command.length === 0) {
        return false;
      }
      const ok = await tryExec(command);
      if (!ok) {
        return false;
      }
    }
    return true;
  }

  private validateCapabilityPolicy(capabilities: string[]): { ok: boolean; error?: string } {
    const defaultMode = this.capabilityPolicy.defaultMode ?? "allow";
    for (const capability of [...new Set(capabilities)]) {
      const mode = this.capabilityPolicy.capabilities?.[capability] ?? defaultMode;
      if (mode === "deny") {
        return { ok: false, error: `Capability denied by policy: ${capability}` };
      }
      if (mode === "ask") {
        return { ok: false, error: `Capability requires approval before execution: ${capability}` };
      }
    }
    return { ok: true };
  }

  private quarantine(skillId: string, reason: string, manifestPath?: string): void {
    const entry: QuarantinedExternalSkill = { skillId, reason, ...(manifestPath ? { manifestPath } : {}) };
    this.quarantinedSkills.set(skillId, entry);
    devWarn(`External skill "${skillId}" is runtime-inactive: ${reason}`);
  }

  private async executeTool(toolName: string, input: unknown, _context?: ToolExecutionContext): Promise<ToolResult> {
    const tool = this.toolRecords.get(toolName);
    if (!tool) {
      return { ok: false, error: `Unknown external tool: ${toolName}` };
    }

    const secretRefs = [...new Set([...(tool.skill.auth.secretRefs ?? []), ...(tool.auth.secretRefs ?? [])])];
    const secrets = await this.loadSecrets(secretRefs);
    if (!secrets.ok || !secrets.bundle) {
      return { ok: false, error: secrets.error ?? `Missing required secret for ${toolName}` };
    }

    let result: ToolResult;
    if (tool.execution.backend === "shell" || tool.execution.backend === "command") {
      result = await this.executeShellTool(tool, input, secrets.bundle);
    } else if (tool.execution.backend === "http") {
      result = await this.executeHttpTool(tool, input, secrets.bundle);
    } else if (tool.execution.backend === "curl") {
      result = await this.executeCurlTool(tool, input, secrets.bundle);
    } else if (tool.execution.backend === "node") {
      result = {
        ok: false,
        error: `Adapter-backed external tools are not executable through ExternalSkillRegistry; use skill activation to run ${toolName}.`,
      };
    } else {
      result = { ok: false, error: `Unsupported external backend for ${toolName}` };
    }

    return this.redactResult(result, tool, secrets.bundle.valueList);
  }

  private async loadSecrets(secretRefs: string[]): Promise<{ ok: true; bundle: LoadedSecretsBundle } | { ok: false; error: string; bundle?: undefined }> {
    const env: Record<string, string> = {};
    const values: Record<string, string> = {};
    const valueList: string[] = [];

    for (const ref of secretRefs) {
      const resolved = await this.secretResolver.resolve(ref);
      if (!resolved.ok || !resolved.value) {
        return { ok: false, error: resolved.error ?? `Missing secret ${ref}` };
      }
      values[ref] = resolved.value;
      valueList.push(resolved.value);
      Object.assign(env, resolved.env ?? {});
    }

    return { ok: true, bundle: { env, values, valueList } };
  }

  private getInputObject(input: unknown): Record<string, unknown> {
    return isPlainObject(input) ? input : {};
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
        Object.entries(value).map(([key, nestedValue]) => [key, this.renderStructuredTemplateValue(nestedValue, input, secrets)]),
      );
    }
    return value;
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
          const items = value.map((item) => stringifyCommandValue(item).trim()).filter((item) => item.length > 0);
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

        const renderedValue = stringifyCommandValue(value).trim();
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

  private buildShellArgs(execution: Extract<ExternalExecutionSpec, { backend: "shell" | "command" }>, input: Record<string, unknown>, secrets: Record<string, string>): string[] {
    if (Array.isArray(execution.args) && execution.args.length > 0) {
      return this.buildArgsFromSpec(execution.args, input, secrets);
    }
    return (execution.argsTemplate ?? [])
      .map((arg) => this.renderTemplate(arg, input, secrets).trim())
      .filter((arg) => arg.length > 0);
  }

  private resolveCommandCwd(
    skill: ExternalSkillRecord,
    execution: Extract<ExternalExecutionSpec, { backend: "shell" | "command" }>,
    input: Record<string, unknown>,
    secrets: Record<string, string>,
  ): string {
    if (!execution.cwdTemplate) {
      return skill.skillDir;
    }
    const rendered = this.renderTemplate(execution.cwdTemplate, input, secrets).trim();
    return rendered.length > 0 ? resolve(rendered) : skill.skillDir;
  }

  private formatCommandSuccess(outputMode: ExternalCommandOutputMode | undefined, stdout: string, stderr: string): ToolResult {
    const normalizedStdout = stdout.trim();
    const normalizedStderr = stderr.trim();
    const mode = outputMode ?? "envelope";

    if (mode === "text") {
      return { ok: true, output: normalizedStdout.length > 0 ? normalizedStdout : normalizedStderr };
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
      } catch (error) {
        return {
          ok: false,
          error: `External command returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
          output: JSON.stringify({ stdout: normalizedStdout, stderr: normalizedStderr }, null, 2),
        };
      }
    }

    return {
      ok: true,
      output: JSON.stringify({ stdout: normalizedStdout, stderr: normalizedStderr, exitCode: 0 }, null, 2),
    };
  }

  private formatCommandFailure(message: string, stdout: string, stderr: string, exitCode: number | null): ToolResult {
    return {
      ok: false,
      error: message,
      output: JSON.stringify({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode }, null, 2),
    };
  }

  private async executeShellTool(tool: ExternalToolRecord, input: unknown, secrets: LoadedSecretsBundle): Promise<ToolResult> {
    if (tool.execution.backend !== "shell" && tool.execution.backend !== "command") {
      return { ok: false, error: "Invalid shell execution configuration." };
    }

    const inputObject = this.getInputObject(input);
    const args = this.buildShellArgs(tool.execution, inputObject, secrets.values);
    const env = {
      ...process.env,
      ...Object.fromEntries(
        Object.entries(tool.execution.env ?? {}).map(([key, value]) => [key, this.renderTemplate(value, inputObject, secrets.values)]),
      ),
      ...secrets.env,
    } as Record<string, string>;
    const cwd = this.resolveCommandCwd(tool.skill, tool.execution, inputObject, secrets.values);

    try {
      const result = await execFileAsync(tool.execution.command, args, {
        timeout: tool.policy.timeoutMs ?? tool.skill.policy.timeoutMs ?? 30_000,
        env,
        cwd,
        maxBuffer: 2 * 1024 * 1024,
      });
      return this.formatCommandSuccess(tool.execution.outputMode, result.stdout, result.stderr);
    } catch (error) {
      const details = error as ExecErrorWithOutput;
      const message = details instanceof Error ? details.message : String(details);
      return this.formatCommandFailure(
        `External shell execution failed: ${message}`,
        details.stdout ?? "",
        details.stderr ?? "",
        typeof details.code === "number" ? details.code : null,
      );
    }
  }

  private isAllowedHttpDomain(hostname: string, allowedDomains: string[]): boolean {
    return allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  }

  private async executeHttpTool(tool: ExternalToolRecord, input: unknown, secrets: LoadedSecretsBundle): Promise<ToolResult> {
    if (tool.execution.backend !== "http") {
      return { ok: false, error: "Invalid HTTP execution configuration." };
    }

    const inputObject = this.getInputObject(input);
    const url = this.renderTemplate(tool.execution.url, inputObject, secrets.values);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return { ok: false, error: `External HTTP execution failed: invalid URL (${error instanceof Error ? error.message : String(error)})` };
    }

    const allowedDomains = normalizeStringArray(tool.execution.allowedDomains);
    if (allowedDomains.length === 0 || !this.isAllowedHttpDomain(parsedUrl.hostname, allowedDomains)) {
      return { ok: false, error: `External HTTP execution blocked: ${parsedUrl.hostname} is not in the allowed domain list.` };
    }

    const controller = new AbortController();
    const timeoutMs = tool.policy.timeoutMs ?? tool.skill.policy.timeoutMs ?? 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = Object.fromEntries(
        Object.entries(tool.execution.headers ?? {}).map(([key, value]) => [key, this.renderTemplate(value, inputObject, secrets.values)]),
      );
      const renderedBody = typeof tool.execution.bodyTemplate === "string"
        ? this.renderTemplate(tool.execution.bodyTemplate, inputObject, secrets.values)
        : tool.execution.bodyTemplate
          ? JSON.stringify(this.renderStructuredTemplateValue(tool.execution.bodyTemplate, inputObject, secrets.values))
          : undefined;
      const response = await fetch(url, {
        method: tool.execution.method ?? "GET",
        headers,
        body: renderedBody,
        signal: controller.signal,
        redirect: "error",
      });
      const body = await response.text();
      return {
        ok: response.ok,
        output: JSON.stringify({ status: response.status, body }, null, 2),
        ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
      };
    } catch (error) {
      return { ok: false, error: `External HTTP execution failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeCurlTool(tool: ExternalToolRecord, input: unknown, secrets: LoadedSecretsBundle): Promise<ToolResult> {
    if (tool.execution.backend !== "curl") {
      return { ok: false, error: "Invalid curl execution configuration." };
    }

    const inputObject = this.getInputObject(input);
    const url = this.renderTemplate(tool.execution.url, inputObject, secrets.values);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (error) {
      return { ok: false, error: `External curl execution failed: invalid URL (${error instanceof Error ? error.message : String(error)})` };
    }

    const allowedDomains = normalizeStringArray(tool.execution.allowedDomains);
    if (allowedDomains.length === 0 || !this.isAllowedHttpDomain(parsedUrl.hostname, allowedDomains)) {
      return { ok: false, error: `External curl execution blocked: ${parsedUrl.hostname} is not in the allowed domain list.` };
    }

    const headers = Object.entries(tool.execution.headers ?? {}).flatMap(([key, value]) => ["-H", `${key}: ${this.renderTemplate(value, inputObject, secrets.values)}`]);
    const body = typeof tool.execution.bodyTemplate === "string"
      ? this.renderTemplate(tool.execution.bodyTemplate, inputObject, secrets.values)
      : tool.execution.bodyTemplate
        ? JSON.stringify(this.renderStructuredTemplateValue(tool.execution.bodyTemplate, inputObject, secrets.values))
        : undefined;
    const args = [
      "-sS",
      "-X",
      tool.execution.method ?? "GET",
      ...headers,
      ...(body ? ["--data", body] : []),
      url,
    ];

    try {
      const result = await execFileAsync("curl", args, {
        timeout: tool.policy.timeoutMs ?? tool.skill.policy.timeoutMs ?? 30_000,
        env: { ...process.env, ...secrets.env } as Record<string, string>,
        cwd: tool.skill.skillDir,
        maxBuffer: 2 * 1024 * 1024,
      });
      return this.formatCommandSuccess("text", result.stdout, result.stderr);
    } catch (error) {
      const details = error as ExecErrorWithOutput;
      const message = details instanceof Error ? details.message : String(details);
      return this.formatCommandFailure(
        `External curl execution failed: ${message}`,
        details.stdout ?? "",
        details.stderr ?? "",
        typeof details.code === "number" ? details.code : null,
      );
    }
  }

  private redactResult(result: ToolResult, tool: ExternalToolRecord, secretValues: string[]): ToolResult {
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
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        fieldSet.has(key) ? "[REDACTED]" : this.redactUnknown(nestedValue, secretValues, redactedFields),
      ]),
    );
  }

  private redactText(text: string, secretValues: string[], redactedFields: string[]): string {
    let redacted = text;
    for (const secret of [...new Set(secretValues)].sort((left, right) => right.length - left.length)) {
      if (secret.length > 0) {
        redacted = redacted.split(secret).join("[REDACTED]");
      }
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
}
