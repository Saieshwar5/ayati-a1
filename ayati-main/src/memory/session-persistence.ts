import {
  appendFileSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  existsSync,
  renameSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentStepEvent, CountableSessionEvent, SessionEvent, SessionOpenEvent, ToolSessionEvent } from "./session-events.js";
import { serializeEvent, deserializeEvent, isCountableSessionEvent, isAgentStepEvent } from "./session-events.js";
import { InMemorySession } from "./session.js";
import type { ConversationTurn } from "./types.js";
import { SqliteMemoryIndex } from "./sqlite-memory-index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

const META_MARKER = "AYATI_SESSION_META";
const EVENT_MARKER = "AYATI_EVENT";
const EVENTS_SECTION_MARKER = "## Events\n\n";

interface SessionDocumentMetadata {
  v: 1;
  session_id: string;
  client_id: string;
  session_path: string;
  status: "active" | "closed" | "crashed";
  opened_at: string;
  closed_at: string | null;
  close_reason: string | null;
  parent_session_id: string | null;
  handoff_summary: string | null;
  updated_at: string;
}

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

function escapeMetaValue(value: string | null): string {
  if (value === null) return "null";
  return value.replace(/\n/g, "\\n");
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
    this.migrateLegacyDatePartitionLayout();
  }

  stop(): void {
    this.metaIndex.stop();
  }

  buildSessionPath(_nowIso: string, sessionId: string): string {
    return `sessions/${sessionId}.md`;
  }

  resolveSessionAbsolutePath(sessionPath: string): string {
    return resolve(this.dataDir, normalizePath(sessionPath));
  }

  appendEvent(event: SessionEvent): void {
    const filePath = this.resolveSessionAbsolutePath(event.sessionPath);
    mkdirSync(dirname(filePath), { recursive: true });
    this.ensureSessionDocument(filePath, event);
    appendFileSync(filePath, this.renderEventEntry(event), "utf8");

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
      this.updateSessionMetadata(filePath, {
        status: "closed",
        closed_at: event.ts,
        close_reason: event.reason,
        handoff_summary: event.handoffSummary ?? null,
        updated_at: event.ts,
      });
      return;
    }

    this.metaIndex.recordEvent(event.sessionId, event.ts);
  }

  getSessionFilePath(sessionId: string): string {
    const existing = this.findSessionRelativePathById(sessionId);
    if (existing) {
      return this.resolveSessionAbsolutePath(existing);
    }
    return this.resolveSessionAbsolutePath(`sessions/legacy/${sessionId}.md`);
  }

  getActiveSessionInfo(clientId?: string): ActiveSessionInfo | null {
    if (clientId) {
      const active = this.metaIndex.getActiveSession(clientId);
      if (active) {
        return {
          sessionId: active.sessionId,
          sessionPath: normalizePath(active.sessionPath),
        };
      }
    }

    const markerPath = resolve(this.sessionsDir, "active-session.json");
    if (existsSync(markerPath)) {
      try {
        const raw = readFileSync(markerPath, "utf8");
        const parsed = JSON.parse(raw) as ActiveSessionInfo;
        if (
          typeof parsed.sessionId === "string" && parsed.sessionId.trim().length > 0 &&
          typeof parsed.sessionPath === "string" && parsed.sessionPath.trim().length > 0
        ) {
          return {
            sessionId: parsed.sessionId.trim(),
            sessionPath: normalizePath(parsed.sessionPath.trim()),
          };
        }
      } catch {
        return null;
      }
      return null;
    }

    // Backward compatibility with older marker format.
    const legacyMarkerPath = resolve(this.sessionsDir, "active-session.txt");
    if (!existsSync(legacyMarkerPath)) return null;

    try {
      const sessionId = readFileSync(legacyMarkerPath, "utf8").trim();
      if (sessionId.length === 0) return null;
      const sessionPath = this.findSessionRelativePathById(sessionId) ?? `sessions/legacy/${sessionId}.md`;
      return { sessionId, sessionPath };
    } catch {
      return null;
    }
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
    const filePath = this.getSessionFilePath(sessionId);
    this.updateSessionMetadata(filePath, {
      status: "crashed",
      close_reason: reason,
      closed_at: ts,
      updated_at: ts,
    });
  }

  resumeSession(
    sessionId: string,
    clientId: string,
    sessionPath: string,
    ts: string,
    options?: { parentSessionId?: string; handoffSummary?: string },
  ): void {
    this.metaIndex.resumeSession(sessionId, clientId, normalizePath(sessionPath), ts, options);
    const filePath = this.resolveSessionAbsolutePath(sessionPath);
    const patch: Partial<Pick<
      SessionDocumentMetadata,
      "status" | "closed_at" | "close_reason" | "updated_at" | "parent_session_id" | "handoff_summary"
    >> = {
      status: "active",
      closed_at: null,
      close_reason: null,
      updated_at: ts,
    };
    if (options?.parentSessionId !== undefined) {
      patch.parent_session_id = options.parentSessionId;
    }
    if (options?.handoffSummary !== undefined) {
      patch.handoff_summary = options.handoffSummary;
    }
    this.updateSessionMetadata(filePath, patch);
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

    const events = this.parseEventsFromContent(content);
    const metadata = this.parseSessionMetadata(content);
    const inferredPath = this.toRelativeSessionPath(filePath);
    let session: InMemorySession | null = null;

    for (const event of events) {
      if (event.type === "session_open") {
        session = new InMemorySession(
          event.sessionId,
          event.clientId,
          event.ts,
          inferredPath,
        );
        continue;
      }

      if (!session || event.type === "session_close") continue;
      session.addEntry(this.withInferredSessionPath(event, inferredPath));
    }

    if (!session && metadata) {
      session = new InMemorySession(
        metadata.session_id,
        metadata.client_id,
        metadata.opened_at,
        inferredPath,
      );
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
    for (const event of this.parseEventsFromContent(content)) {
      if (event.type === "user_message") {
        turns.push({
          role: "user",
          content: event.content,
          timestamp: event.ts,
          sessionPath: inferredPath,
        });
      } else if (event.type === "assistant_message") {
        turns.push({
          role: "assistant",
          content: event.content,
          timestamp: event.ts,
          sessionPath: inferredPath,
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
    for (const event of this.parseEventsFromContent(content)) {
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
    for (const event of this.parseEventsFromContent(content)) {
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
    for (const event of this.parseEventsFromContent(content)) {
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

      const metadata = this.parseSessionMetadata(content);
      const inferredPath = this.toRelativeSessionPath(filePath);
      let matchesClient = metadata?.client_id === clientId;

      for (const event of this.parseEventsFromContent(content)) {
        if (event.type === "session_open" && !metadata) {
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
          });
        } else if (event.type === "assistant_message") {
          turns.push({
            role: "assistant",
            content: event.content,
            timestamp: event.ts,
            sessionPath: inferredPath,
          });
        }
      }
    }

    turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return turns;
  }

  private ensureSessionDocument(filePath: string, event: SessionEvent): void {
    if (existsSync(filePath)) return;

    const meta = this.defaultMetadataFromEvent(event);
    writeFileSync(filePath, this.renderSessionDocument(meta, ""), "utf8");
  }

  private defaultMetadataFromEvent(event: SessionEvent): SessionDocumentMetadata {
    if (event.type === "session_open") {
      const open = event as SessionOpenEvent;
      return {
        v: 1,
        session_id: open.sessionId,
        client_id: open.clientId,
        session_path: open.sessionPath,
        status: "active",
        opened_at: open.ts,
        closed_at: null,
        close_reason: null,
        parent_session_id: open.parentSessionId ?? null,
        handoff_summary: open.handoffSummary ?? null,
        updated_at: open.ts,
      };
    }

    return {
      v: 1,
      session_id: event.sessionId,
      client_id: "unknown",
      session_path: event.sessionPath,
      status: "active",
      opened_at: event.ts,
      closed_at: null,
      close_reason: null,
      parent_session_id: null,
      handoff_summary: null,
      updated_at: event.ts,
    };
  }

  private renderSessionDocument(metadata: SessionDocumentMetadata, eventsBody: string): string {
    const body = eventsBody.trim().length > 0
      ? `${eventsBody.trimEnd()}\n`
      : "";
    return [
      "# Ayati Session",
      "",
      `<!-- ${META_MARKER} ${JSON.stringify(metadata)} -->`,
      "",
      "## Metadata",
      `- session_id: ${metadata.session_id}`,
      `- client_id: ${metadata.client_id}`,
      `- session_path: ${metadata.session_path}`,
      `- status: ${metadata.status}`,
      `- opened_at: ${metadata.opened_at}`,
      `- closed_at: ${escapeMetaValue(metadata.closed_at)}`,
      `- close_reason: ${escapeMetaValue(metadata.close_reason)}`,
      `- parent_session_id: ${escapeMetaValue(metadata.parent_session_id)}`,
      `- handoff_summary: ${escapeMetaValue(metadata.handoff_summary)}`,
      `- updated_at: ${metadata.updated_at}`,
      "",
      "## Events",
      "",
      body,
    ].join("\n");
  }

  private renderEventEntry(event: SessionEvent): string {
    const pretty = JSON.stringify(event, null, 2);
    const compact = serializeEvent(event);
    return [
      `### ${event.ts} | ${event.type}`,
      "",
      "```json",
      pretty,
      "```",
      "",
      `<!-- ${EVENT_MARKER} ${compact} -->`,
      "",
    ].join("\n");
  }

  private updateSessionMetadata(
    filePath: string,
    patch: Partial<Pick<
      SessionDocumentMetadata,
      "status" | "closed_at" | "close_reason" | "handoff_summary" | "updated_at" | "parent_session_id"
    >>,
  ): void {
    if (!existsSync(filePath)) return;

    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      return;
    }

    const metadata = this.parseSessionMetadata(content);
    if (!metadata) return;

    const merged: SessionDocumentMetadata = {
      ...metadata,
      ...patch,
    };
    const eventsBody = this.extractEventsBody(content);
    writeFileSync(filePath, this.renderSessionDocument(merged, eventsBody), "utf8");
  }

  private parseSessionMetadata(content: string): SessionDocumentMetadata | null {
    const pattern = new RegExp(`<!--\\s*${META_MARKER}\\s+(.+?)\\s*-->`);
    const match = content.match(pattern);
    if (!match || !match[1]) return null;

    try {
      const parsed = JSON.parse(match[1]) as SessionDocumentMetadata;
      if (parsed && parsed.v === 1 && typeof parsed.session_id === "string") {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private extractEventsBody(content: string): string {
    const idx = content.indexOf(EVENTS_SECTION_MARKER);
    if (idx < 0) return "";
    return content.slice(idx + EVENTS_SECTION_MARKER.length).trim();
  }

  private parseEventsFromContent(content: string): SessionEvent[] {
    const events: SessionEvent[] = [];
    const markerPattern = new RegExp(`<!--\\s*${EVENT_MARKER}\\s+(.+?)\\s*-->`, "g");
    let match: RegExpExecArray | null = null;
    while ((match = markerPattern.exec(content)) !== null) {
      const payload = match[1];
      if (!payload) continue;
      try {
        events.push(deserializeEvent(payload));
      } catch {
        // ignore malformed marker
      }
    }
    if (events.length > 0) return events;

    // Legacy fallback: parse JSONL lines.
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(deserializeEvent(trimmed));
      } catch {
        // ignore malformed line
      }
    }

    return events;
  }

  private findSessionRelativePathById(sessionId: string): string | null {
    const files = this.listSessionFiles(this.sessionsDir);
    const mdSuffix = `/${sessionId}.md`;
    const jsonlSuffix = `/${sessionId}.jsonl`;
    for (const filePath of files) {
      const normalized = normalizePath(filePath);
      if (normalized.endsWith(mdSuffix) || normalized.endsWith(jsonlSuffix)) {
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
      } else if (entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".jsonl"))) {
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

  private migrateLegacyDatePartitionLayout(): void {
    const files = this.listSessionFiles(this.sessionsDir);
    if (files.length === 0) {
      this.rewriteMarkerPathToFlat();
      return;
    }

    const updatedAt = new Date().toISOString();
    const movedPathMap = new Map<string, string>();

    for (const filePath of files) {
      const oldRelPath = this.toRelativeSessionPath(filePath);
      const flatPath = this.toFlatSessionPath(oldRelPath);
      if (!flatPath || flatPath === oldRelPath) continue;

      const oldAbsPath = this.resolveSessionAbsolutePath(oldRelPath);
      const newAbsPath = this.resolveSessionAbsolutePath(flatPath);
      mkdirSync(dirname(newAbsPath), { recursive: true });

      try {
        if (!existsSync(newAbsPath)) {
          renameSync(oldAbsPath, newAbsPath);
        }
      } catch {
        continue;
      }

      movedPathMap.set(oldRelPath, flatPath);
      const sessionId = this.extractSessionIdFromPath(flatPath);
      if (!sessionId) continue;
      this.metaIndex.updateSessionPath(sessionId, flatPath, updatedAt);
    }

    this.rewriteMarkerPathToFlat(movedPathMap);
  }

  private toFlatSessionPath(sessionPath: string): string | null {
    const normalized = normalizePath(sessionPath);
    // Match date-partitioned layouts: sessions/YYYY/MM/DD/file or sessions/YYYY-MM-DD/file
    const deepMatch = normalized.match(/^sessions\/\d{4}\/\d{2}\/\d{2}\/(.+)$/);
    if (deepMatch && deepMatch[1]) return `sessions/${deepMatch[1]}`;

    const flatDateMatch = normalized.match(/^sessions\/\d{4}-\d{2}-\d{2}\/(.+)$/);
    if (flatDateMatch && flatDateMatch[1]) return `sessions/${flatDateMatch[1]}`;

    return null;
  }

  private extractSessionIdFromPath(sessionPath: string): string | null {
    const normalized = normalizePath(sessionPath);
    const name = normalized.split("/").pop();
    if (!name || name.length === 0) return null;
    const withoutExt = name.replace(/\.(md|jsonl)$/i, "");
    return withoutExt.length > 0 ? withoutExt : null;
  }

  private rewriteMarkerPathToFlat(movedPathMap?: Map<string, string>): void {
    const markerPath = resolve(this.sessionsDir, "active-session.json");
    if (!existsSync(markerPath)) return;

    let parsed: ActiveSessionInfo | null = null;
    try {
      parsed = JSON.parse(readFileSync(markerPath, "utf8")) as ActiveSessionInfo;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.sessionPath !== "string") return;

    const normalized = normalizePath(parsed.sessionPath);
    const mapped = movedPathMap?.get(normalized);
    const converted = mapped ?? this.toFlatSessionPath(normalized);
    if (!converted || converted === normalized) return;

    writeFileSync(
      markerPath,
      JSON.stringify({ sessionId: parsed.sessionId, sessionPath: converted }),
      "utf8",
    );
  }
}
