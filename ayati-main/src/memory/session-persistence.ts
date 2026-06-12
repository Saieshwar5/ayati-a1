import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  appendFile as appendFileAsync,
  mkdir as mkdirAsync,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent } from "./session-events.js";
import { deserializeEvent, serializeEvent } from "./session-events.js";
import { SqliteMemoryIndex } from "./sqlite-memory-index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

export interface ActiveSessionInfo {
  sessionId: string;
  sessionPath: string;
}

export interface SessionPersistenceOptions {
  dbPath?: string;
  dataDir?: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export class SessionPersistence {
  private readonly dataDir: string;
  private readonly metaIndex: SqliteMemoryIndex;
  readonly sessionsDir: string;

  constructor(options?: SessionPersistenceOptions) {
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.sessionsDir = resolve(this.dataDir, "sessions");
    this.metaIndex = new SqliteMemoryIndex({
      dataDir: this.dataDir,
      dbPath: options?.dbPath,
    });
  }

  start(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    this.metaIndex.start();
  }

  stop(): void {
    this.metaIndex.stop();
  }

  buildSessionPath(sessionDate: string, sessionId: string): string {
    return `sessions/${sessionDate}/${sessionId}.jsonl`;
  }

  resolveSessionAbsolutePath(sessionPath: string): string {
    return resolve(this.dataDir, normalizePath(sessionPath));
  }

  appendEvent(event: SessionEvent): void {
    const filePath = this.resolveSessionAbsolutePath(event.sessionPath);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${serializeEvent(event)}\n`, "utf8");
    this.indexEvent(event);
  }

  async appendEventAsync(event: SessionEvent): Promise<void> {
    const filePath = this.resolveSessionAbsolutePath(event.sessionPath);
    await mkdirAsync(dirname(filePath), { recursive: true });
    await appendFileAsync(filePath, `${serializeEvent(event)}\n`, "utf8");
    this.indexEvent(event);
  }

  getActiveSessionInfo(clientId?: string): ActiveSessionInfo | null {
    if (!clientId) return null;
    const active = this.metaIndex.getActiveSession(clientId);
    if (!active) return null;
    return {
      sessionId: active.sessionId,
      sessionPath: normalizePath(active.sessionPath),
    };
  }

  getSessionRelativePath(sessionId: string): string | null {
    return this.findSessionRelativePathById(sessionId);
  }

  getSessionFilePath(sessionId: string): string {
    const existing = this.findSessionRelativePathById(sessionId);
    if (existing) {
      return this.resolveSessionAbsolutePath(existing);
    }
    return this.resolveSessionAbsolutePath(`sessions/${sessionId}.jsonl`);
  }

  writeActiveSessionMarker(sessionId: string, sessionPath: string): void {
    const markerPath = resolve(this.sessionsDir, "active-session.json");
    writeFileSync(
      markerPath,
      JSON.stringify({ sessionId, sessionPath: normalizePath(sessionPath) }),
      "utf8",
    );
  }

  clearActiveSessionMarker(): void {
    const markerPath = resolve(this.sessionsDir, "active-session.json");
    try {
      unlinkSync(markerPath);
    } catch {
      // ignore ENOENT
    }
  }

  resumeSession(sessionId: string, clientId: string, sessionPath: string, ts: string): void {
    this.metaIndex.resumeSession(sessionId, clientId, normalizePath(sessionPath), ts);
  }

  markSessionCrashed(sessionId: string, ts: string, reason = "restore_failed"): void {
    this.metaIndex.markSessionCrashed(sessionId, ts, reason);
  }

  replaySessionFile(filePath: string): SessionEvent[] {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }
    return this.parseJsonlEvents(content);
  }

  private indexEvent(event: SessionEvent): void {
    if (event.type === "session_open") {
      this.metaIndex.openSession({
        sessionId: event.sessionId,
        clientId: event.clientId,
        sessionPath: event.sessionPath,
        openedAt: event.ts,
      });
      return;
    }

    this.metaIndex.recordEvent(event.sessionId, event.ts);
  }

  private parseJsonlEvents(content: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(deserializeEvent(trimmed));
      } catch {
        // Ignore malformed lines so a partial final append does not hide older events.
      }
    }
    return events;
  }

  private findSessionRelativePathById(sessionId: string): string | null {
    const files = this.listSessionFiles(this.sessionsDir);
    const jsonlSuffix = `/${sessionId}.jsonl`;
    for (const filePath of files) {
      const normalized = normalizePath(filePath);
      if (normalized.endsWith(jsonlSuffix)) {
        return this.toRelativeSessionPath(filePath);
      }
    }
    return null;
  }

  private listSessionFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];

    const files: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...this.listSessionFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
    return files;
  }

  private toRelativeSessionPath(filePath: string): string {
    return normalizePath(relative(this.dataDir, filePath));
  }
}
