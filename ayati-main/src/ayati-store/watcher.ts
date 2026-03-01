import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_SCAN_INTERVAL_MS = 200;

type SkillEventName = "skill-added" | "skill-removed";

export interface SkillMeta {
  id: string;
  version: string;
  title: string;
  description: string;
  tags: string[];
  state: string;
  folder: string;
}

export interface StoreWatcher {
  on(event: "skill-added", listener: (meta: SkillMeta) => void): this;
  on(event: "skill-removed", listener: (meta: SkillMeta) => void): this;
  stop(): void;
  getKnownSkills(): SkillMeta[];
}

interface SkillManifest {
  schemaVersion: string;
  id: string;
  version: string;
  title: string;
  description: string;
  tags?: string[];
  status?: {
    state?: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string): SkillManifest | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return null;
    if (parsed["schemaVersion"] !== "ayati-skill/v1") return null;
    if (typeof parsed["id"] !== "string") return null;
    if (typeof parsed["version"] !== "string") return null;
    if (typeof parsed["title"] !== "string") return null;
    if (typeof parsed["description"] !== "string") return null;
    const tags = Array.isArray(parsed["tags"]) ? parsed["tags"] : undefined;
    const status = isObject(parsed["status"]) ? parsed["status"] : undefined;
    return {
      schemaVersion: parsed["schemaVersion"],
      id: parsed["id"],
      version: parsed["version"],
      title: parsed["title"],
      description: parsed["description"],
      ...(tags ? { tags: tags as string[] } : {}),
      ...(status ? {
        status: {
          state: typeof status["state"] === "string" ? status["state"] : undefined,
        },
      } : {}),
    };
  } catch {
    return null;
  }
}

function toSkillMeta(folder: string, manifest: SkillManifest): SkillMeta {
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    description: manifest.description,
    tags: Array.isArray(manifest.tags) ? manifest.tags.filter((tag): tag is string => typeof tag === "string") : [],
    state: typeof manifest.status?.state === "string" ? manifest.status.state : "unknown",
    folder,
  };
}

class PollingStoreWatcher extends EventEmitter implements StoreWatcher {
  private readonly rootDir: string;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private knownByFolder = new Map<string, SkillMeta>();
  private stopped = false;
  private scanInFlight = false;

  constructor(rootDir: string, intervalMs: number) {
    super();
    this.rootDir = rootDir;
    this.intervalMs = intervalMs;
  }

  static async start(rootDir: string, intervalMs = DEFAULT_SCAN_INTERVAL_MS): Promise<PollingStoreWatcher> {
    await mkdir(rootDir, { recursive: true });
    const watcher = new PollingStoreWatcher(rootDir, intervalMs);
    await watcher.scan(false);
    watcher.timer = setInterval(() => {
      void watcher.scan(true);
    }, watcher.intervalMs);
    return watcher;
  }

  getKnownSkills(): SkillMeta[] {
    return [...this.knownByFolder.values()].sort((a, b) => a.folder.localeCompare(b.folder));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.removeAllListeners();
  }

  private async scan(emitChanges: boolean): Promise<void> {
    if (this.stopped || this.scanInFlight) {
      return;
    }

    this.scanInFlight = true;
    try {
      const nextByFolder = await this.collectCurrentSkills();
      if (emitChanges && !this.stopped) {
        this.emitDiff(nextByFolder);
      }
      this.knownByFolder = nextByFolder;
    } finally {
      this.scanInFlight = false;
    }
  }

  private emitDiff(nextByFolder: Map<string, SkillMeta>): void {
    for (const [folder, nextMeta] of nextByFolder.entries()) {
      if (!this.knownByFolder.has(folder)) {
        this.emit("skill-added", nextMeta);
      }
    }

    for (const [folder, currentMeta] of this.knownByFolder.entries()) {
      if (!nextByFolder.has(folder)) {
        this.emit("skill-removed", currentMeta);
      }
    }
  }

  private async collectCurrentSkills(): Promise<Map<string, SkillMeta>> {
    const next = new Map<string, SkillMeta>();
    const entries = await readdir(this.rootDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const folder = entry.name;
      const skillJsonPath = join(this.rootDir, folder, "skill.json");

      let raw = "";
      try {
        raw = await readFile(skillJsonPath, "utf8");
      } catch {
        continue;
      }

      const manifest = parseManifest(raw);
      if (!manifest) continue;
      next.set(folder, toSkillMeta(folder, manifest));
    }

    return next;
  }
}

export async function startStoreWatcher(rootDir: string): Promise<StoreWatcher> {
  return PollingStoreWatcher.start(rootDir, DEFAULT_SCAN_INTERVAL_MS);
}
