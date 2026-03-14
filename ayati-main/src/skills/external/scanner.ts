import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { devLog, devWarn, devError } from "../../shared/index.js";
import type {
  ExternalSkillMeta,
  ExternalSkillManifest,
  ExternalSkillRuntime,
  ExternalSkillType,
} from "./types.js";

const execAsync = promisify(exec);

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
      result[key] = value?.trim() || "";
      continue;
    }

    const nested = line.match(/^\s+(\w[\w-]*):\s*(.*)/);
    if (nested && currentKey) {
      const [, subKey, subValue] = nested;
      if (!subKey) continue;
      const parent = result[currentKey];
      if (typeof parent === "string" && parent === "") {
        result[currentKey] = { [subKey]: subValue?.trim() || "" };
      } else if (typeof parent === "object" && parent !== null) {
        (parent as Record<string, string>)[subKey] = subValue?.trim() || "";
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

export async function scanExternalSkills(skillsDir: string): Promise<ExternalSkillMeta[]> {
  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    return [];
  }

  const skills: ExternalSkillMeta[] = [];

  for (const entry of entries) {
    const skillFilePath = join(skillsDir, entry, "skill.md");
    let raw: string;
    try {
      raw = await readFile(skillFilePath, "utf-8");
    } catch {
      continue;
    }

    const manifest = parseYamlFrontmatter(raw) as unknown as ExternalSkillManifest;

    if (!manifest.id || !manifest.description) {
      devWarn(`Skipping skill in ${entry}: missing id or description`);
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

    devLog(
      `Loaded external skill: ${manifest.id} (type=${type}, runtime=${runtime}, installed=${installed})`,
    );

    skills.push({
      id: manifest.id,
      type,
      runtime,
      ...(plugin ? { plugin } : {}),
      description: manifest.description,
      skillFilePath,
      skillDir: join(skillsDir, entry),
      installed,
      start: manifest.start,
      stop: manifest.stop,
    });
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
