import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { devLog, devWarn, devError } from "../../shared/index.js";
import type {
  ExternalSkillMeta,
  ExternalSkillManifest,
  ExternalSkillRuntime,
  ExternalSkillScanRoot,
  ExternalSkillSource,
  ExternalSkillType,
} from "./types.js";

const execAsync = promisify(exec);
const SKILL_FILENAMES = ["skill.md", "SKILL.md"] as const;

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};

  const result: Record<string, unknown> = {};
  const lines = match[1].split("\n");

  let currentKey = "";

  for (const line of lines) {
    const topLevel = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (topLevel) {
      const [, key, value] = topLevel;
      if (!key) continue;
      currentKey = key;
      result[key] = value ? normalizeYamlScalar(value) : "";
      continue;
    }

    const listItem = line.match(/^\s+-\s*(.*)/);
    if (listItem && currentKey) {
      const [, itemValue] = listItem;
      const nextValue = normalizeYamlScalar(itemValue ?? "");
      const parent = result[currentKey];

      if (Array.isArray(parent)) {
        parent.push(nextValue);
      } else if (typeof parent === "string" && parent === "") {
        result[currentKey] = [nextValue];
      } else if (parent === undefined) {
        result[currentKey] = [nextValue];
      }
      continue;
    }

    const nested = line.match(/^\s+(\w[\w-]*):\s*(.*)/);
    if (nested && currentKey) {
      const [, subKey, subValue] = nested;
      if (!subKey) continue;
      const parent = result[currentKey];
      if (typeof parent === "string" && parent === "") {
        result[currentKey] = { [subKey]: normalizeYamlScalar(subValue ?? "") };
      } else if (typeof parent === "object" && parent !== null) {
        (parent as Record<string, string>)[subKey] = normalizeYamlScalar(subValue ?? "");
      }
    }
  }

  return result;
}

async function tryExec(command: string): Promise<boolean> {
  try {
    await execAsync(command, { timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

function normalizeSkillType(value: unknown): ExternalSkillType {
  if (value === "cli" || value === "shell") {
    return value;
  }
  return "shell";
}

function normalizeSkillRuntime(value: unknown): ExternalSkillRuntime {
  if (value === "plugin" || value === "direct") {
    return value;
  }
  return "direct";
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeScanRoots(
  input: string | ExternalSkillScanRoot | Array<string | ExternalSkillScanRoot>,
): ExternalSkillScanRoot[] {
  const values = Array.isArray(input) ? input : [input];
  const roots: ExternalSkillScanRoot[] = [];

  for (const value of values) {
    if (typeof value === "string") {
      roots.push({ skillsDir: value, source: roots.length === 0 ? "project" : "global" });
      continue;
    }

    roots.push({
      skillsDir: value.skillsDir,
      source: value.source ?? (roots.length === 0 ? "project" : "global"),
    });
  }

  return roots;
}

function inferSource(root: ExternalSkillScanRoot): ExternalSkillSource {
  return root.source ?? "project";
}

async function readHelpText(command: string): Promise<string | null> {
  try {
    const result = await execAsync(`${command} --help`, { timeout: 30_000 });
    return [result.stdout, result.stderr].filter(Boolean).join("\n");
  } catch {
    return null;
  }
}

function extractDocumentedSubcommand(command: string, documentedCommand: string): string | null {
  const trimmed = documentedCommand.trim();
  if (!trimmed.startsWith(`${command} `)) {
    return null;
  }

  const suffix = trimmed.slice(command.length).trim();
  if (suffix.length === 0 || suffix.startsWith("\"") || suffix.startsWith("'") || suffix.startsWith("--")) {
    return null;
  }

  const [subcommand] = suffix.split(/\s+/, 1);
  if (!subcommand || !/^[a-z][a-z0-9-]*$/i.test(subcommand)) {
    return null;
  }

  return subcommand;
}

async function validateCanonicalCommands(skill: ExternalSkillMeta): Promise<void> {
  if (skill.type !== "cli" || !skill.installed || !skill.command || !skill.commands || skill.commands.length === 0) {
    return;
  }

  const helpText = await readHelpText(skill.command);
  if (!helpText) {
    devWarn(`Unable to validate documented commands for skill "${skill.id}" because "${skill.command} --help" failed.`);
    return;
  }

  for (const documentedCommand of skill.commands) {
    const subcommand = extractDocumentedSubcommand(skill.command, documentedCommand);
    if (!subcommand) {
      continue;
    }

    const subcommandPattern = new RegExp(`(^|\\n)\\s*${subcommand}(\\s|$)`, "m");
    if (!subcommandPattern.test(helpText)) {
      devWarn(
        `Skill "${skill.id}" documents command "${documentedCommand}" but "${skill.command} --help" does not list subcommand "${subcommand}".`,
      );
    }
  }
}

export async function scanExternalSkills(
  skillsDir: string | ExternalSkillScanRoot | Array<string | ExternalSkillScanRoot>,
): Promise<ExternalSkillMeta[]> {
  const roots = normalizeScanRoots(skillsDir);
  let entries: string[];
  const skills: ExternalSkillMeta[] = [];
  const seenIds = new Set<string>();

  for (const root of roots) {
    try {
      entries = await readdir(root.skillsDir);
    } catch {
      continue;
    }

    for (const entry of entries.sort()) {
      let raw = "";
      let skillFilePath: string | null = null;

      for (const skillFilename of SKILL_FILENAMES) {
        const candidatePath = join(root.skillsDir, entry, skillFilename);
        try {
          raw = await readFile(candidatePath, "utf-8");
          skillFilePath = candidatePath;
          break;
        } catch {
          continue;
        }
      }

      if (!skillFilePath) {
        continue;
      }

      const manifest = parseYamlFrontmatter(raw) as unknown as ExternalSkillManifest;

      if (!manifest.id || !manifest.description) {
        devWarn(`Skipping skill in ${entry}: missing id or description`);
        continue;
      }

      if (seenIds.has(manifest.id)) {
        devLog(
          `Skipping duplicate external skill "${manifest.id}" from ${skillFilePath}; an earlier root already provided it.`,
        );
        continue;
      }

      const type = normalizeSkillType(manifest.type);
      const runtime = normalizeSkillRuntime(manifest.runtime);
      const plugin = typeof manifest.plugin === "string" && manifest.plugin.trim().length > 0
        ? manifest.plugin.trim()
        : undefined;

      if (runtime === "plugin" && !plugin) {
        devWarn(`Skill "${manifest.id}" declares runtime=plugin but has no plugin field`);
      }

      let installed = true;

      if (manifest.dependency?.check) {
        const depOk = await tryExec(manifest.dependency.check);
        if (!depOk && manifest.dependency.install) {
          devLog(`Installing dependency for skill "${manifest.id}"...`);
          const installOk = await tryExec(manifest.dependency.install);
          if (!installOk) {
            devWarn(`Failed to install dependency for skill "${manifest.id}"`);
            installed = false;
          }
        } else if (!depOk) {
          installed = false;
        }
      }

      if (installed && manifest.start) {
        const started = await tryExec(manifest.start);
        if (!started) {
          devWarn(`Failed to start skill "${manifest.id}"`);
        }
      }

      const skill: ExternalSkillMeta = {
        id: manifest.id,
        type,
        runtime,
        source: inferSource(root),
        resolvedFrom: root.skillsDir,
        ...(plugin ? { plugin } : {}),
        ...(normalizeOptionalString(manifest.command) ? { command: normalizeOptionalString(manifest.command) } : {}),
        ...(normalizeStringArray(manifest.commands) ? { commands: normalizeStringArray(manifest.commands) } : {}),
        ...(normalizeStringArray(manifest.aliases) ? { aliases: normalizeStringArray(manifest.aliases) } : {}),
        description: manifest.description,
        skillFilePath,
        skillDir: join(root.skillsDir, entry),
        installed,
        start: manifest.start,
        stop: manifest.stop,
      };

      await validateCanonicalCommands(skill);

      devLog(
        `Loaded external skill: ${manifest.id} (type=${type}, runtime=${runtime}, source=${skill.source}, installed=${installed}${skill.command ? `, command=${skill.command}` : ""})`,
      );

      skills.push(skill);
      seenIds.add(skill.id);
    }
  }

  return skills;
}

export async function stopExternalSkills(skills: ExternalSkillMeta[]): Promise<void> {
  for (const skill of skills) {
    if (skill.stop) {
      try {
        await execAsync(skill.stop, { timeout: 10_000 });
        devLog(`Stopped external skill: ${skill.id}`);
      } catch (err) {
        devError(`Failed to stop skill "${skill.id}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
