import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  existsSync,
} from "node:fs";
import {
  appendFile as appendFileAsync,
  mkdir as mkdirAsync,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentStepEvent, CountableSessionEvent, SessionEvent, ToolSessionEvent } from "./session-events.js";
import { serializeEvent, deserializeEvent, isCountableSessionEvent, isAgentStepEvent } from "./session-events.js";
import { InMemorySession } from "./session.js";
import type { ConversationTurn } from "./types.js";
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

  buildSessionPath(_nowIso: string, sessionId: string): string {
    return `sessions/${sessionId}.jsonl`;
  }

  resolveSessionAbsolutePath(sessionPath: string): string {
    return resolve(this.dataDir, normalizePath(sessionPath));
  }

  appendEvent(event: SessionEvent): void {
    const filePath = this.resolveSessionAbsolutePath(event.sessionPath);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${serializeEvent(event)}\n`, "utf8");

    if (event.type === "session_open") {
      this.metaIndex.openSession({
        sessionId: event.sessionId,
        clientId: event.clientId,
        sessionPath: event.sessionPath,
        openedAt: event.ts,
        parentSessionId: event.parentSessionId,
        handoffSummary: event.handoffSummary,
      });
      return;
    }

    if (event.type === "session_close") {
      this.metaIndex.closeSession(event.sessionId, event.ts, event.reason, event.handoffSummary);
      return;
    }

    this.metaIndex.recordEvent(event.sessionId, event.ts);
  }

  async appendEventAsync(event: SessionEvent): Promise<void> {
    const filePath = this.resolveSessionAbsolutePath(event.sessionPath);
    await mkdirAsync(dirname(filePath), { recursive: true });
    await appendFileAsync(filePath, `${serializeEvent(event)}\n`, "utf8");

    if (event.type === "session_open") {
      this.metaIndex.openSession({
        sessionId: event.sessionId,
        clientId: event.clientId,
        sessionPath: event.sessionPath,
        openedAt: event.ts,
        parentSessionId: event.parentSessionId,
        handoffSummary: event.handoffSummary,
      });
      return;
    }

    if (event.type === "session_close") {
      this.metaIndex.closeSession(event.sessionId, event.ts, event.reason, event.handoffSummary);
      return;
    }

    this.metaIndex.recordEvent(event.sessionId, event.ts);
  }

  getSessionFilePath(sessionId: string): string {
    const existing = this.findSessionRelativePathById(sessionId);
    if (existing) {
      return this.resolveSessionAbsolutePath(existing);
    }
    return this.resolveSessionAbsolutePath(`sessions/${sessionId}.jsonl`);
  }

  getSessionRelativePath(sessionId: string): string | null {
    return this.findSessionRelativePathById(sessionId);
  }

  getActiveSessionInfo(clientId?: string): ActiveSessionInfo | null {
    if (clientId) {
      const active = this.metaIndex.getActiveSession(clientId);
      if (!active) return null;
      return {
        sessionId: active.sessionId,
        sessionPath: normalizePath(active.sessionPath),
      };
    }

    return null;
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

    const legacyMarkerPath = resolve(this.sessionsDir, "active-session.txt");
    try {
      unlinkSync(legacyMarkerPath);
    } catch {
      // ignore ENOENT
    }
  }

  markSessionCrashed(sessionId: string, ts: string, reason = "restore_failed"): void {
    this.metaIndex.markSessionCrashed(sessionId, ts, reason);
  }

  resumeSession(
    sessionId: string,
    clientId: string,
    sessionPath: string,
    ts: string,
    options?: { parentSessionId?: string; handoffSummary?: string },
  ): void {
    const normalizedSessionPath = normalizePath(sessionPath);
    this.metaIndex.resumeSession(sessionId, clientId, normalizedSessionPath, ts, options);
  }

  listRecoveryCandidates(clientId: string, limit = 16): ActiveSessionInfo[] {
    const cappedLimit = Math.max(1, Math.min(200, limit));
    const sessions = this.metaIndex.listRecentSessions(clientId, cappedLimit);
    if (sessions.length === 0) return [];

    const seen = new Set<string>();
    const candidates: ActiveSessionInfo[] = [];
    for (const session of sessions) {
      const recoverable =
        session.status === "active" ||
        session.status === "crashed" ||
        session.closeReason === "shutdown";
      if (!recoverable) continue;
      if (seen.has(session.sessionId)) continue;
      seen.add(session.sessionId);
      candidates.push({
        sessionId: session.sessionId,
        sessionPath: normalizePath(session.sessionPath),
      });
    }

    return candidates;
  }

  loadRecentCountableEvents(clientId: string, limit: number): CountableSessionEvent[] {
    const cappedLimit = Math.max(1, Math.min(200, limit));
    const sessions = this.metaIndex.listRecentSessions(clientId, 80);
    if (sessions.length === 0) return [];

    const collected: CountableSessionEvent[] = [];
    for (const session of sessions) {
      const sessionFilePath = this.resolveSessionAbsolutePath(session.sessionPath);
      const sessionEvents = this.loadCountableEventsFromSessionFile(sessionFilePath);
      for (let i = sessionEvents.length - 1; i >= 0; i--) {
        const event = sessionEvents[i];
        if (!event) continue;
        collected.push(event);
        if (collected.length >= cappedLimit) {
          return collected.reverse();
        }
      }
    }

    return collected.reverse();
  }

  loadRecentToolEvents(clientId: string, limit: number): ToolSessionEvent[] {
    const cappedLimit = Math.max(1, Math.min(200, limit));
    const sessions = this.metaIndex.listRecentSessions(clientId, 80);
    if (sessions.length === 0) return [];

    const collected: ToolSessionEvent[] = [];
    for (const session of sessions) {
      const sessionFilePath = this.resolveSessionAbsolutePath(session.sessionPath);
      const sessionEvents = this.loadToolEventsFromSessionFile(sessionFilePath);
      for (let i = sessionEvents.length - 1; i >= 0; i--) {
        const event = sessionEvents[i];
        if (!event) continue;
        collected.push(event);
        if (collected.length >= cappedLimit) {
          return collected.reverse();
        }
      }
    }

    return collected.reverse();
  }

  loadRecentAgentStepEvents(clientId: string, limit: number): AgentStepEvent[] {
    const cappedLimit = Math.max(1, Math.min(200, limit));
    const sessions = this.metaIndex.listRecentSessions(clientId, 80);
    if (sessions.length === 0) return [];

    const collected: AgentStepEvent[] = [];
    for (const session of sessions) {
      const sessionFilePath = this.resolveSessionAbsolutePath(session.sessionPath);
      const sessionEvents = this.loadAgentStepEventsFromSessionFile(sessionFilePath);
      for (let i = sessionEvents.length - 1; i >= 0; i--) {
        const event = sessionEvents[i];
        if (!event) continue;
        collected.push(event);
        if (collected.length >= cappedLimit) {
          return collected.reverse();
        }
      }
    }

    return collected.reverse();
  }

  replaySessionFile(filePath: string): InMemorySession | null {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }

    if (content.trim().length === 0) return null;

    const events = this.parseJsonlEvents(content);
    const inferredPath = this.toRelativeSessionPath(filePath);
    let session: InMemorySession | null = null;

    for (const event of events) {
      if (event.type === "session_open") {
        session = new InMemorySession(
          event.sessionId,
          event.clientId,
          event.ts,
          inferredPath,
          event.parentSessionId ?? null,
        );
        if (event.handoffSummary) {
          session.handoffSummary = event.handoffSummary;
        }
        continue;
      }

      if (!session || event.type === "session_close") continue;
      session.addEntry(this.withInferredSessionPath(event, inferredPath));
    }

    return session;
  }

  loadSessionTurns(sessionId: string): ConversationTurn[] {
    const filePath = this.getSessionFilePath(sessionId);
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }

    const turns: ConversationTurn[] = [];
    const inferredPath = this.toRelativeSessionPath(filePath);
    for (const event of this.parseJsonlEvents(content)) {
      if (event.type === "user_message") {
        turns.push({
          role: "user",
          content: event.content,
          timestamp: event.ts,
          sessionPath: inferredPath,
          runId: event.runId,
        });
      } else if (event.type === "assistant_message" || event.type === "assistant_feedback") {
        turns.push({
          role: "assistant",
          content: event.type === "assistant_message" ? event.content : event.message,
          timestamp: event.ts,
          sessionPath: inferredPath,
          runId: event.type === "assistant_message" ? event.runId : undefined,
          assistantResponseKind: event.type === "assistant_message"
            ? (event.responseKind ?? "reply")
            : "feedback",
        });
      }
    }

    return turns;
  }

  private loadCountableEventsFromSessionFile(filePath: string): CountableSessionEvent[] {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }

    const events: CountableSessionEvent[] = [];
    const inferredPath = this.toRelativeSessionPath(filePath);
    for (const event of this.parseJsonlEvents(content)) {
      if (isCountableSessionEvent(event)) {
        events.push(this.withInferredSessionPath(event, inferredPath));
      }
    }

    return events;
  }

  private loadToolEventsFromSessionFile(filePath: string): ToolSessionEvent[] {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }

    const events: ToolSessionEvent[] = [];
    const inferredPath = this.toRelativeSessionPath(filePath);
    for (const event of this.parseJsonlEvents(content)) {
      if (event.type === "tool_call" || event.type === "tool_result") {
        events.push(this.withInferredSessionPath(event, inferredPath));
      }
    }

    return events;
  }

  private loadAgentStepEventsFromSessionFile(filePath: string): AgentStepEvent[] {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return [];
    }

    const events: AgentStepEvent[] = [];
    const inferredPath = this.toRelativeSessionPath(filePath);
    for (const event of this.parseJsonlEvents(content)) {
      if (isAgentStepEvent(event)) {
        events.push(this.withInferredSessionPath(event, inferredPath));
      }
    }

    return events;
  }

  loadConversationTurns(clientId: string): ConversationTurn[] {
    const files = this.listSessionFiles(this.sessionsDir);
    const turns: ConversationTurn[] = [];

    for (const filePath of files) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      const inferredPath = this.toRelativeSessionPath(filePath);
      let matchesClient = false;

      for (const event of this.parseJsonlEvents(content)) {
        if (event.type === "session_open") {
          matchesClient = event.clientId === clientId;
          continue;
        }

        if (!matchesClient) continue;

        if (event.type === "user_message") {
          turns.push({
            role: "user",
            content: event.content,
            timestamp: event.ts,
            sessionPath: inferredPath,
            runId: event.runId,
          });
        } else if (event.type === "assistant_message" || event.type === "assistant_feedback") {
          turns.push({
            role: "assistant",
            content: event.type === "assistant_message" ? event.content : event.message,
            timestamp: event.ts,
            sessionPath: inferredPath,
            runId: event.type === "assistant_message" ? event.runId : undefined,
            assistantResponseKind: event.type === "assistant_message"
              ? (event.responseKind ?? "reply")
              : "feedback",
          });
        }
      }
    }

    turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return turns;
  }

  private parseJsonlEvents(content: string): SessionEvent[] {
    const events: SessionEvent[] = [];

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const event = deserializeEvent(trimmed);
        if (isRemovedLegacyEvent(event)) {
          continue;
        }
        events.push(event);
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
    const rel = relative(this.dataDir, filePath);
    return normalizePath(rel);
  }

  private withInferredSessionPath<T extends SessionEvent>(event: T, inferredPath: string): T {
    if (event.sessionPath === inferredPath) return event;
    return {
      ...event,
      sessionPath: inferredPath,
    };
  }

}

function isRemovedLegacyEvent(event: SessionEvent): boolean {
  const type = (event as { type?: string }).type;
  return type === "run_ledger" || type === "feedback_opened" || type === "feedback_resolved";
}
