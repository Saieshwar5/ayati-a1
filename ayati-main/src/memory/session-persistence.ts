import { appendFileSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionEvent, ToolContextEntry } from "./session-events.js";
import { serializeEvent, deserializeEvent } from "./session-events.js";
import { InMemorySession } from "./session.js";
import type { ConversationTurn } from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

const LARGE_OUTPUT_THRESHOLD = 2000;

export interface SessionPersistenceOptions {
  // Kept for backward compatibility with existing call sites; filesystem-only persistence ignores it.
  dbPath?: string;
  dataDir?: string;
}

export class SessionPersistence {
  private readonly dataDir: string;
  readonly sessionsDir: string;
  private readonly toolOutputDir: string;
  private readonly toolContextDir: string;

  constructor(options?: SessionPersistenceOptions) {
    this.dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.sessionsDir = resolve(this.dataDir, "sessions");
    this.toolOutputDir = resolve(this.dataDir, "tool-output");
    this.toolContextDir = resolve(this.dataDir, "tool-context");
  }

  start(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.toolOutputDir, { recursive: true });
    mkdirSync(this.toolContextDir, { recursive: true });
  }

  stop(): void {
    // no-op for filesystem-only persistence
  }

  appendEvent(event: SessionEvent): void {
    const filePath = this.getSessionFilePath(event.sessionId);
    const line = serializeEvent(event);
    appendFileSync(filePath, `${line}\n`, "utf8");
  }

  getSessionFilePath(sessionId: string): string {
    return resolve(this.sessionsDir, `${sessionId}.jsonl`);
  }

  getActiveSessionId(): string | null {
    const markerPath = resolve(this.sessionsDir, "active-session.txt");
    try {
      return readFileSync(markerPath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  writeActiveSessionMarker(sessionId: string): void {
    const markerPath = resolve(this.sessionsDir, "active-session.txt");
    writeFileSync(markerPath, sessionId, "utf8");
  }

  clearActiveSessionMarker(): void {
    const markerPath = resolve(this.sessionsDir, "active-session.txt");
    try {
      unlinkSync(markerPath);
    } catch {
      // ignore ENOENT
    }
  }

  replaySessionFile(filePath: string): InMemorySession | null {
    let content: string;
    try {
      content = readFileSync(filePath, "utf8").trim();
    } catch {
      return null;
    }

    if (content.length === 0) return null;

    const lines = content.split("\n");
    let session: InMemorySession | null = null;

    for (const line of lines) {
      if (line.trim().length === 0) continue;

      let event: SessionEvent;
      try {
        event = deserializeEvent(line);
      } catch {
        continue;
      }

      if (event.type === "session_open") {
        session = new InMemorySession(
          event.sessionId,
          event.clientId,
          event.ts,
        );
        continue;
      }

      if (!session) continue;

      if (
        event.type === "user_message" ||
        event.type === "assistant_message" ||
        event.type === "tool_call" ||
        event.type === "tool_result" ||
        event.type === "run_failure"
      ) {
        session.addEntry(event);
      }
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
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let event: SessionEvent;
      try {
        event = deserializeEvent(trimmed);
      } catch {
        continue;
      }

      if (event.type === "user_message") {
        turns.push({ role: "user", content: event.content, timestamp: event.ts });
      } else if (event.type === "assistant_message") {
        turns.push({ role: "assistant", content: event.content, timestamp: event.ts });
      }
    }

    return turns;
  }

  loadConversationTurns(clientId: string): ConversationTurn[] {
    const files = readdirSync(this.sessionsDir).filter((name) => name.endsWith(".jsonl"));
    const turns: ConversationTurn[] = [];

    for (const fileName of files) {
      const filePath = resolve(this.sessionsDir, fileName);
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }

      let matchesClient = false;
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;

        let event: SessionEvent;
        try {
          event = deserializeEvent(trimmed);
        } catch {
          continue;
        }

        if (event.type === "session_open") {
          matchesClient = event.clientId === clientId;
          continue;
        }

        if (!matchesClient) continue;

        if (event.type === "user_message") {
          turns.push({ role: "user", content: event.content, timestamp: event.ts });
        } else if (event.type === "assistant_message") {
          turns.push({ role: "assistant", content: event.content, timestamp: event.ts });
        }
      }
    }

    turns.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return turns;
  }

  persistLargeToolOutput(sessionId: string, toolCallId: string, toolName: string, output: string): string | null {
    if (output.length <= LARGE_OUTPUT_THRESHOLD) return null;

    const sanitizedToolName = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sanitizedCallId = toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${sessionId}-${sanitizedToolName}-${sanitizedCallId}.txt`;
    const filePath = resolve(this.toolOutputDir, fileName);

    writeFileSync(filePath, output, "utf8");
    return filePath;
  }

  appendToolContextEntry(toolName: string, entry: ToolContextEntry): void {
    const sanitized = toolName.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = resolve(this.toolContextDir, `${sanitized}.jsonl`);
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  }
}
