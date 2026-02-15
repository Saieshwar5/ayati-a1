import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import { EventEmitter } from "node:events";
import { devLog, devWarn } from "../shared/index.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SkillMeta {
  id: string;
  folder: string;
  version: string;
  title: string;
  description: string;
  state: "draft" | "stable" | "deprecated";
  tags: string[];
}

export interface StoreWatcher {
  on(event: "skill-added", cb: (meta: SkillMeta) => void): void;
  on(event: "skill-removed", cb: (meta: SkillMeta) => void): void;
  stop(): void;
  getKnownSkills(): SkillMeta[];
}

// ── Helpers ────────────────────────────────────────────────────────

const VALID_STATES = new Set(["draft", "stable", "deprecated"]);

async function readSkillMeta(storePath: string, folder: string): Promise<SkillMeta | undefined> {
  const skillJsonPath = join(storePath, folder, "skill.json");
  let raw: string;
  try {
    raw = await readFile(skillJsonPath, "utf-8");
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    devWarn(`Invalid JSON in ${skillJsonPath}`);
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;

  if (obj["schemaVersion"] !== "ayati-skill/v1") {
    devWarn(`Unsupported schemaVersion in ${skillJsonPath}`);
    return undefined;
  }
  if (typeof obj["id"] !== "string" || typeof obj["version"] !== "string") return undefined;
  if (typeof obj["title"] !== "string" || typeof obj["description"] !== "string") return undefined;

  const status = obj["status"] as Record<string, unknown> | undefined;
  const stateRaw = status && typeof status === "object" ? status["state"] : undefined;
  const state = typeof stateRaw === "string" && VALID_STATES.has(stateRaw)
    ? (stateRaw as SkillMeta["state"])
    : "draft";

  const tagsRaw = obj["tags"];
  const tags = Array.isArray(tagsRaw)
    ? tagsRaw.filter((t): t is string => typeof t === "string")
    : [];

  return {
    id: obj["id"],
    version: obj["version"],
    title: obj["title"],
    description: obj["description"],
    state,
    tags,
    folder,
  };
}

async function scanSkillFolders(storePath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(storePath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// ── Watcher ────────────────────────────────────────────────────────

const DEBOUNCE_MS = 500;

export async function startStoreWatcher(storePath: string): Promise<StoreWatcher> {
  const emitter = new EventEmitter();
  const knownSkills = new Map<string, SkillMeta>();

  // Initial scan
  const folders = await scanSkillFolders(storePath);
  for (const folder of folders) {
    const meta = await readSkillMeta(storePath, folder);
    if (meta) {
      knownSkills.set(folder, meta);
      devLog(`Store: found skill ${meta.id} v${meta.version} in ${folder}/`);
    }
  }

  // Debounced re-scan
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function rescan(): Promise<void> {
    const currentFolders = new Set(await scanSkillFolders(storePath));

    // Detect removals
    for (const [folder, meta] of knownSkills) {
      if (!currentFolders.has(folder)) {
        knownSkills.delete(folder);
        emitter.emit("skill-removed", meta);
      }
    }

    // Detect additions
    for (const folder of currentFolders) {
      if (!knownSkills.has(folder)) {
        const meta = await readSkillMeta(storePath, folder);
        if (meta) {
          knownSkills.set(folder, meta);
          emitter.emit("skill-added", meta);
        } else {
          devWarn(`Store: folder ${folder}/ has no valid skill.json, skipping`);
        }
      }
    }
  }

  let fsWatcher: FSWatcher;
  try {
    fsWatcher = watch(storePath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void rescan(), DEBOUNCE_MS);
    });
  } catch (err) {
    devWarn(`Store: could not watch ${storePath}: ${err}`);
    return {
      on: () => {},
      stop: () => {},
      getKnownSkills: () => [...knownSkills.values()],
    };
  }

  return {
    on(event: string, cb: (meta: SkillMeta) => void): void {
      emitter.on(event, cb);
    },
    stop(): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      fsWatcher.close();
      emitter.removeAllListeners();
    },
    getKnownSkills(): SkillMeta[] {
      return [...knownSkills.values()];
    },
  };
}
