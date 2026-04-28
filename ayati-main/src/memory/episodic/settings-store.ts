import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EpisodicMemorySettings } from "./types.js";

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data", "memory", "episodic");
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

export interface EpisodicMemorySettingsStoreOptions {
  dataDir?: string;
  settingsFileName?: string;
  defaultEmbeddingModel?: string;
}

interface SettingsFile {
  v: 1;
  clients: Record<string, EpisodicMemorySettings>;
}

export class EpisodicMemorySettingsStore {
  private readonly settingsPath: string;
  private readonly defaultEmbeddingModel: string;

  constructor(options?: EpisodicMemorySettingsStoreOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.settingsPath = resolve(dataDir, options?.settingsFileName ?? "settings.json");
    this.defaultEmbeddingModel = options?.defaultEmbeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  }

  get(clientId: string): EpisodicMemorySettings {
    const normalizedClientId = normalizeClientId(clientId);
    const file = this.readFile();
    return file.clients[normalizedClientId] ?? this.defaultSettings(normalizedClientId);
  }

  setEnabled(clientId: string, enabled: boolean, nowIso = new Date().toISOString()): EpisodicMemorySettings {
    const normalizedClientId = normalizeClientId(clientId);
    const file = this.readFile();
    const current = file.clients[normalizedClientId] ?? this.defaultSettings(normalizedClientId);
    const next: EpisodicMemorySettings = {
      ...current,
      episodicEnabled: enabled,
      updatedAt: nowIso,
    };
    file.clients[normalizedClientId] = next;
    this.writeFile(file);
    return next;
  }

  private defaultSettings(clientId: string): EpisodicMemorySettings {
    return {
      clientId,
      episodicEnabled: false,
      embeddingProvider: "openai",
      embeddingModel: this.defaultEmbeddingModel,
      updatedAt: new Date(0).toISOString(),
    };
  }

  private readFile(): SettingsFile {
    if (!existsSync(this.settingsPath)) {
      return { v: 1, clients: {} };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return { v: 1, clients: {} };
      }
      const value = parsed as Partial<SettingsFile>;
      if (value.v !== 1 || !value.clients || typeof value.clients !== "object") {
        return { v: 1, clients: {} };
      }
      return {
        v: 1,
        clients: Object.fromEntries(
          Object.entries(value.clients)
            .filter((entry): entry is [string, EpisodicMemorySettings] => isSettings(entry[1])),
        ),
      };
    } catch {
      return { v: 1, clients: {} };
    }
  }

  private writeFile(file: SettingsFile): void {
    mkdirSync(dirname(this.settingsPath), { recursive: true });
    writeFileSync(this.settingsPath, JSON.stringify(file, null, 2), "utf8");
  }
}

function normalizeClientId(clientId: string): string {
  const trimmed = clientId.trim();
  return trimmed.length > 0 ? trimmed : "local";
}

function isSettings(value: unknown): value is EpisodicMemorySettings {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row["clientId"] === "string"
    && typeof row["episodicEnabled"] === "boolean"
    && row["embeddingProvider"] === "openai"
    && typeof row["embeddingModel"] === "string"
    && typeof row["updatedAt"] === "string"
  );
}
