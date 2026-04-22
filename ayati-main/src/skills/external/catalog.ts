import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { devLog, devWarn } from "../../shared/index.js";
import type {
  ExternalCommandArgSpec,
  ExternalDependencyCheck,
  ExternalExecutionPolicy,
  ExternalSkillCatalog,
  ExternalSkillManifest,
  ExternalPluginIntegration,
  ExternalSkillScanRoot,
  ExternalSkillSource,
  ExternalToolManifest,
  NormalizedExternalSkill,
  NormalizedExternalTool,
  SecretRefConfig,
  SkillSearchKind,
  SkillSearchResult,
  StructuredSkillManifest,
} from "./types.js";
import {
  SKILL_FILENAMES,
  inferSource,
  normalizeScanRoots,
  parseYamlFrontmatter,
  tryExec,
} from "./scanner.js";
import { buildExternalToolDescription, validatePortableToolInputSchema } from "./tool-schema.js";

const TOOL_MANIFEST_EXTENSION = ".json";

const SYNONYM_MAP: Record<string, string[]> = {
  mail: ["email", "gmail", "message", "thread", "inbox"],
  email: ["mail", "gmail", "message", "thread", "inbox"],
  gmail: ["email", "mail", "message", "thread", "inbox"],
  pr: ["pull", "pullrequest", "review", "github", "comments"],
  repo: ["repository", "github"],
  docs: ["document", "documentation", "doc"],
  calendar: ["meeting", "event", "schedule"],
  browser: ["web", "page", "agent-browser", "playwright"],
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

function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
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

function normalizePolicy(value: ExternalExecutionPolicy | undefined): ExternalExecutionPolicy {
  return {
    capabilities: normalizeStringArray(value?.capabilities),
    ...(value?.defaultMode ? { defaultMode: value.defaultMode } : {}),
    ...(typeof value?.timeoutMs === "number" ? { timeoutMs: value.timeoutMs } : {}),
    ...(value?.retryPolicy ? { retryPolicy: value.retryPolicy } : {}),
    redactedFields: normalizeStringArray(value?.redactedFields),
  };
}

function normalizeSecretConfig(value: SecretRefConfig | undefined): SecretRefConfig {
  return {
    ...(typeof value?.required === "boolean" ? { required: value.required } : {}),
    secretRefs: normalizeStringArray(value?.secretRefs),
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

function normalizePluginIntegration(value: unknown): { plugin?: ExternalPluginIntegration } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const pluginValue = (value as Record<string, unknown>)["plugin"];
  if (!pluginValue || typeof pluginValue !== "object" || Array.isArray(pluginValue)) {
    return undefined;
  }

  const pluginName = normalizeOptionalString((pluginValue as Record<string, unknown>)["name"]);
  if (!pluginName) {
    return undefined;
  }

  return {
    plugin: {
      name: pluginName,
      ...(
        typeof (pluginValue as Record<string, unknown>)["required"] === "boolean"
          ? { required: Boolean((pluginValue as Record<string, unknown>)["required"]) }
          : {}
      ),
    },
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }

  if (a.length === 0) {
    return b.length;
  }

  if (b.length === 0) {
    return a.length;
  }

  const previous = new Array<number>(b.length + 1).fill(0).map((_, index) => index);
  const current = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (current[j - 1] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[j] ?? Number.POSITIVE_INFINITY) + 1,
        (previous[j - 1] ?? Number.POSITIVE_INFINITY) + cost,
      );
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j] ?? Number.POSITIVE_INFINITY;
    }
  }

  return previous[b.length] ?? Math.max(a.length, b.length);
}

function isSmallTypoMatch(token: string, value: string): boolean {
  if (token.length < 4 || value.length < 4) {
    return false;
  }

  if (Math.abs(token.length - value.length) > 1) {
    return false;
  }

  return levenshteinDistance(token, value) <= 1;
}

function expandQueryTokens(tokens: string[]): string[] {
  const expanded = new Set<string>(tokens);
  for (const token of tokens) {
    for (const synonym of SYNONYM_MAP[token] ?? []) {
      expanded.add(synonym);
    }
  }
  return [...expanded];
}

function buildSearchCorpus(skill: NormalizedExternalSkill, tool?: NormalizedExternalTool): string[] {
  const values = [
    skill.id,
    skill.title,
    skill.description,
    ...skill.domains,
    ...skill.tags,
    ...skill.aliases,
    ...skill.triggers,
    ...skill.legacyCommands,
  ];

  if (tool) {
    values.push(
      tool.id,
      tool.title,
      tool.description,
      ...tool.aliases,
      ...tool.tags,
      ...tool.triggers,
      tool.action ?? "",
      tool.object ?? "",
      tool.provider ?? "",
    );
  }

  return values.filter((value) => value.trim().length > 0);
}

function scoreMatch(
  skill: NormalizedExternalSkill,
  tool: NormalizedExternalTool | undefined,
  query: string,
  queryTokens: string[],
): SkillSearchResult | null {
  const corpus = buildSearchCorpus(skill, tool);
  const lowerCorpus = corpus.map((value) => value.toLowerCase());
  const skillId = skill.id.toLowerCase();
  const toolId = tool?.id.toLowerCase();
  const toolName = tool ? `${skill.id}.${tool.id}`.toLowerCase() : undefined;
  let score = 0;
  const reasons: string[] = [];

  if (toolName && query === toolName) {
    score += 50;
    reasons.push("matched tool name");
  }

  for (const token of queryTokens) {
    const exactId = tool ? toolId === token : skillId === token;
    if (exactId) {
      score += 40;
      reasons.push("matched exact id");
      continue;
    }

    if (toolName && toolName.startsWith(token)) {
      score += 24;
      reasons.push("matched tool name");
      continue;
    }

    if (skill.aliases.some((alias) => alias.toLowerCase() === token) || tool?.aliases.some((alias) => alias.toLowerCase() === token)) {
      score += 24;
      reasons.push("matched alias");
      continue;
    }

    if (skillId.startsWith(token) || toolId?.startsWith(token)) {
      score += 18;
      reasons.push("matched prefix");
      continue;
    }

    if (skill.domains.some((domain) => domain.toLowerCase() === token) || tool?.provider?.toLowerCase() === token) {
      score += 18;
      reasons.push("matched domain/provider");
      continue;
    }

    if (skill.tags.some((tag) => tag.toLowerCase() === token) || tool?.tags.some((tag) => tag.toLowerCase() === token)) {
      score += 14;
      reasons.push("matched tag");
      continue;
    }

    if (lowerCorpus.some((value) => value.includes(token))) {
      score += 8;
      reasons.push("matched phrase");
      continue;
    }

    if (lowerCorpus.some((value) => isSmallTypoMatch(token, value))) {
      score += 4;
      reasons.push("matched fuzzy");
      continue;
    }
  }

  if (score === 0) {
    return null;
  }

  if (skill.installed) {
    score += 5;
  }

  if (skill.source === "project") {
    score += 3;
  }

  return {
    type: tool ? "tool" : "workflow",
    score,
    skillId: skill.id,
    ...(tool ? { toolId: tool.id, toolName: `${skill.id}.${tool.id}` } : {}),
    title: tool?.title ?? skill.title,
    description: tool?.description ?? skill.description,
    workflowOnly: skill.workflowOnly,
    matchReasons: [...new Set(reasons)].slice(0, 4),
    domains: [...skill.domains],
    tags: tool ? [...tool.tags] : [...skill.tags],
  };
}

async function findDocsPath(skillDir: string, preferred?: string): Promise<string | undefined> {
  const candidates = preferred ? [preferred, ...SKILL_FILENAMES] : [...SKILL_FILENAMES];
  for (const candidate of candidates) {
    try {
      const resolved = join(skillDir, candidate);
      await readFile(resolved, "utf-8");
      return resolved;
    } catch {
      continue;
    }
  }
  return undefined;
}

function buildDependencyCommand(check: ExternalDependencyCheck): string {
  const args = Array.isArray(check.args) ? check.args.join(" ") : "";
  return `${check.command}${args ? ` ${args}` : ""}`.trim();
}

async function computeInstalled(dependencyChecks: ExternalDependencyCheck[]): Promise<boolean> {
  for (const check of dependencyChecks) {
    if ((check.type ?? "command") !== "command") {
      continue;
    }
    const ok = await tryExec(buildDependencyCommand(check));
    if (!ok) {
      return false;
    }
  }
  return true;
}

async function loadToolManifest(skillDir: string, toolPath: string, skillId: string, skillAuth: SecretRefConfig, skillPolicy: ExternalExecutionPolicy): Promise<NormalizedExternalTool | null> {
  const raw = await readFile(join(skillDir, toolPath), "utf-8");
  const parsed = JSON.parse(raw) as ExternalToolManifest;
  if (!parsed.id || !parsed.description || !parsed.execution?.backend) {
    devWarn(`Skipping external tool ${toolPath} in ${skillId}: missing required fields`);
    return null;
  }

  if (parsed.inputSchema) {
    const schemaValidation = validatePortableToolInputSchema(parsed.inputSchema);
    if (!schemaValidation.ok) {
      devWarn(`Skipping external tool ${toolPath} in ${skillId}: ${schemaValidation.error}`);
      return null;
    }
  }

  return {
    id: parsed.id,
    skillId,
    title: parsed.title?.trim() || parsed.id,
    description: buildExternalToolDescription(parsed.description, parsed.usage),
    usage: parsed.usage ?? {},
    aliases: normalizeStringArray(parsed.aliases),
    tags: normalizeStringArray(parsed.tags),
    triggers: normalizeStringArray(parsed.triggers),
    ...(normalizeOptionalString(parsed.action) ? { action: normalizeOptionalString(parsed.action) } : {}),
    ...(normalizeOptionalString(parsed.object) ? { object: normalizeOptionalString(parsed.object) } : {}),
    ...(normalizeOptionalString(parsed.provider) ? { provider: normalizeOptionalString(parsed.provider) } : {}),
    ...(parsed.inputSchema ? { inputSchema: parsed.inputSchema } : {}),
    ...(parsed.outputSchema ? { outputSchema: parsed.outputSchema } : {}),
    execution: parsed.execution.backend === "command"
      ? {
        ...parsed.execution,
        args: normalizeCommandArgs((parsed.execution as Record<string, unknown>)["args"]),
        ...(normalizeOptionalString((parsed.execution as Record<string, unknown>)["cwdTemplate"]) ? { cwdTemplate: normalizeOptionalString((parsed.execution as Record<string, unknown>)["cwdTemplate"]) } : {}),
        ...(normalizeOptionalString((parsed.execution as Record<string, unknown>)["outputMode"]) ? { outputMode: normalizeOptionalString((parsed.execution as Record<string, unknown>)["outputMode"]) as "text" | "json-stdout" | "envelope" } : {}),
      }
      : parsed.execution,
    auth: {
      required: skillAuth.required || parsed.auth?.required,
      secretRefs: [...new Set([...normalizeStringArray(skillAuth.secretRefs), ...normalizeStringArray(parsed.auth?.secretRefs)])],
    },
    policy: {
      ...skillPolicy,
      ...normalizePolicy(parsed.policy),
      capabilities: [...new Set([...(skillPolicy.capabilities ?? []), ...normalizeStringArray(parsed.policy?.capabilities)])],
      redactedFields: [...new Set([...(skillPolicy.redactedFields ?? []), ...normalizeStringArray(parsed.policy?.redactedFields)])],
    },
    examples: Array.isArray(parsed.examples) ? parsed.examples : [],
  };
}

async function loadStructuredSkill(skillDir: string, source: ExternalSkillSource, resolvedFrom: string): Promise<NormalizedExternalSkill | null> {
  const manifestPath = join(skillDir, "skill.json");
  let raw = "";
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch {
    return null;
  }

  const parsed = JSON.parse(raw) as StructuredSkillManifest;
  if (!parsed.id || !parsed.description) {
    devWarn(`Skipping structured skill in ${skillDir}: missing id or description`);
    return null;
  }
  if (parsed.status && parsed.status !== "active") {
    return null;
  }

  const toolFiles = parsed.toolFiles && parsed.toolFiles.length > 0
    ? [...parsed.toolFiles]
    : (await readdir(join(skillDir, "tools")).catch(() => []))
      .filter((entry) => entry.endsWith(TOOL_MANIFEST_EXTENSION))
      .map((entry) => join("tools", entry));

  const dependencyChecks = (parsed.dependencies?.checks ?? []).map((check) => ({
    type: check.type ?? "command",
    command: check.command,
    args: Array.isArray(check.args) ? [...check.args] : [],
  }));
  const installed = await computeInstalled(dependencyChecks);
  const auth = normalizeSecretConfig(parsed.auth);
  const policy = normalizePolicy(parsed.policy);
  const tools: NormalizedExternalTool[] = [];

  for (const toolFile of toolFiles) {
    try {
      const tool = await loadToolManifest(skillDir, toolFile, parsed.id, auth, policy);
      if (tool) {
        tools.push(tool);
      }
    } catch (err) {
      devWarn(`Failed to load tool manifest ${toolFile} for ${parsed.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    id: parsed.id,
    title: parsed.title?.trim() || parsed.id,
    description: parsed.description.trim(),
    cardSummary: buildCardSummary(parsed, parsed.description.trim()),
    cardWhenToUse: buildCardWhenToUse(parsed),
    ...(normalizeOptionalString(parsed.card?.roleLabel) ? { roleLabel: normalizeOptionalString(parsed.card?.roleLabel) } : {}),
    useFor: normalizeStringArray(parsed.card?.useFor),
    notFor: normalizeStringArray(parsed.card?.notFor),
    ...(normalizeOptionalString(parsed.card?.workflowHint) ? { workflowHint: normalizeOptionalString(parsed.card?.workflowHint) } : {}),
    ...(normalizeOptionalString(parsed.card?.pairedSkillId) ? { pairedSkillId: normalizeOptionalString(parsed.card?.pairedSkillId) } : {}),
    activationBrief: normalizeOptionalString(parsed.activation?.brief)
      ?? buildCardSummary(parsed, parsed.description.trim()),
    activationWorkflow: normalizeStringArray(parsed.activation?.workflow),
    activationRules: normalizeStringArray(parsed.activation?.rules),
    source,
    resolvedFrom,
    skillDir,
    manifestPath,
    docsPath: await findDocsPath(skillDir, parsed.docs?.main),
    ...(parsed.adapter?.entry ? { adapterPath: join(skillDir, parsed.adapter.entry) } : {}),
    installed,
    workflowOnly: tools.length === 0,
    legacy: false,
    domains: normalizeStringArray(parsed.domains),
    tags: normalizeStringArray(parsed.tags),
    aliases: normalizeStringArray(parsed.aliases),
    triggers: normalizeStringArray(parsed.triggers),
    toolFiles,
    tools,
    dependencyChecks,
    policy,
    auth,
    legacyCommands: [],
    defaultActivationScope: parsed.activation?.defaultScope ?? "run",
    ...(normalizePositiveInt(parsed.activation?.maxActiveTools) ? { maxActiveTools: normalizePositiveInt(parsed.activation?.maxActiveTools) } : {}),
    ...(normalizePluginIntegration(parsed.integration) ? { integration: normalizePluginIntegration(parsed.integration) } : {}),
  };
}

async function loadLegacySkill(skillDir: string, source: ExternalSkillSource, resolvedFrom: string): Promise<NormalizedExternalSkill | null> {
  let raw = "";
  let docsPath: string | undefined;
  for (const filename of SKILL_FILENAMES) {
    try {
      docsPath = join(skillDir, filename);
      raw = await readFile(docsPath, "utf-8");
      break;
    } catch {
      continue;
    }
  }

  if (!docsPath) {
    return null;
  }

  const manifest = parseYamlFrontmatter(raw) as ExternalSkillManifest;
  const id = normalizeOptionalString(manifest.id) ?? normalizeOptionalString(manifest.name) ?? basename(skillDir);
  const description = normalizeOptionalString(manifest.description);
  if (!description) {
    devWarn(`Skipping legacy skill in ${skillDir}: missing description`);
    return null;
  }

  const dependencyChecks = manifest.dependency?.check
    ? [{ type: "command" as const, command: manifest.dependency.check }]
    : [];
  const installed = await computeInstalled(dependencyChecks);

  return {
    id,
    title: id,
    description,
    cardSummary: description,
    cardWhenToUse: "Use when this documented legacy workflow clearly matches the task.",
    useFor: [],
    notFor: [],
    activationBrief: description,
    activationWorkflow: [],
    activationRules: [],
    source,
    resolvedFrom,
    skillDir,
    docsPath,
    installed,
    workflowOnly: true,
    legacy: true,
    domains: [],
    tags: [],
    aliases: normalizeStringArray(manifest.aliases),
    triggers: normalizeStringArray(manifest.commands),
    toolFiles: [],
    tools: [],
    dependencyChecks,
    policy: normalizePolicy(undefined),
    auth: normalizeSecretConfig(undefined),
    legacyCommands: normalizeStringArray(manifest.commands),
    defaultActivationScope: "run",
  };
}

export async function loadExternalSkillCatalog(
  roots: string | ExternalSkillScanRoot | Array<string | ExternalSkillScanRoot>,
  options?: { cachePath?: string },
): Promise<ExternalSkillCatalog> {
  const scanRoots = normalizeScanRoots(roots);
  const skills: NormalizedExternalSkill[] = [];
  const seenIds = new Set<string>();

  for (const root of scanRoots) {
    let entries: string[];
    try {
      entries = await readdir(root.skillsDir);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
      const skillDir = join(root.skillsDir, entry);
      const entryStat = await stat(skillDir).catch(() => null);
      if (!entryStat?.isDirectory()) {
        continue;
      }
      const source = inferSource(root);
      const hasStructuredManifest = Boolean(await stat(join(skillDir, "skill.json")).catch(() => null));
      let skill = hasStructuredManifest
        ? await loadStructuredSkill(skillDir, source, root.skillsDir)
        : null;
      if (!skill && !hasStructuredManifest) {
        skill = await loadLegacySkill(skillDir, source, root.skillsDir);
      }
      if (!skill) {
        continue;
      }

      if (seenIds.has(skill.id)) {
        devLog(`Skipping duplicate external skill "${skill.id}" from ${skillDir}; an earlier root already provided it.`);
        continue;
      }

      skills.push(skill);
      seenIds.add(skill.id);
    }
  }

  const catalog: ExternalSkillCatalog = {
    generatedAt: new Date().toISOString(),
    roots: scanRoots,
    skills,
  };

  if (options?.cachePath) {
    const cachePath = resolve(options.cachePath);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify(catalog, null, 2), "utf-8");
  }

  return catalog;
}

export function buildExternalCapabilityDigest(catalog: ExternalSkillCatalog): string {
  const toolCount = catalog.skills.reduce((sum, skill) => sum + skill.tools.length, 0);
  const domains = new Map<string, string[]>();

  for (const skill of catalog.skills) {
    const domainList = skill.domains.length > 0 ? skill.domains : ["general"];
    for (const domain of domainList) {
      const bucket = domains.get(domain) ?? [];
      bucket.push(skill.id);
      domains.set(domain, bucket);
    }
  }

  const domainLines = [...domains.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 6)
    .map(([domain, skillIds]) => `- ${domain}: ${[...new Set(skillIds)].slice(0, 2).join(", ")}`);

  return [
    "External capability broker is available.",
    `Catalog size: ${catalog.skills.length} skills, ${toolCount} typed external tools.`,
    ...(domainLines.length > 0
      ? ["Catalog snapshot:", ...domainLines]
      : ["Catalog snapshot: generic workflow and integration skills."]),
    "Normal controller flow mounts external skills by returning activate_skill with the exact skill_id, then uses the mounted tools after the tool list refreshes.",
  ].join("\n");
}

export function searchExternalSkillCatalog(
  catalog: ExternalSkillCatalog,
  query: string,
  options?: {
    limit?: number;
    kind?: SkillSearchKind;
    installedOnly?: boolean;
  },
): SkillSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  const tokens = expandQueryTokens(tokenize(query));
  const limit = options?.limit ?? 5;
  const kind = options?.kind ?? "tool";
  const installedOnly = options?.installedOnly ?? true;
  const matches: SkillSearchResult[] = [];

  for (const skill of catalog.skills) {
    if (installedOnly && !skill.installed) {
      continue;
    }

    if ((kind === "workflow" || kind === "any") && skill.workflowOnly) {
      const skillMatch = scoreMatch(skill, undefined, normalizedQuery, tokens);
      if (skillMatch) {
        matches.push(skillMatch);
      }
    }

    if (kind === "workflow") {
      continue;
    }

    for (const tool of skill.tools) {
      const toolMatch = scoreMatch(skill, tool, normalizedQuery, tokens);
      if (toolMatch) {
        matches.push(toolMatch);
      }
    }
  }

  return matches
    .sort((a, b) => b.score - a.score || a.skillId.localeCompare(b.skillId) || (a.toolId ?? "").localeCompare(b.toolId ?? ""))
    .slice(0, limit);
}

export function getExternalSkillById(catalog: ExternalSkillCatalog, skillId: string): NormalizedExternalSkill | undefined {
  return catalog.skills.find((skill) => skill.id === skillId);
}
