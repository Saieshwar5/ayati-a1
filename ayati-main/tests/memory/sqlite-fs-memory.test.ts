import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/memory/session-manager.js";
import type { ToolContextEntry } from "../../src/memory/session-events.js";

describe("SessionManager", () => {
  it("stores run + tool events and returns prompt context", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c1");

    const run = manager.beginRun("c1", "find learn1.go");
    manager.recordToolCall("c1", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      args: { cmd: "find . -name learn1.go" },
    });

    manager.recordToolResult("c1", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "t1",
      toolName: "shell",
      status: "success",
      output: "./work_space/calculus/learn1.go",
      durationMs: 22,
    });

    manager.recordAssistantFinal("c1", run.runId, run.sessionId, "Found the file path.");

    const prompt = manager.getPromptMemoryContext();

    expect(prompt.conversationTurns.length).toBeGreaterThanOrEqual(1);
    expect(prompt.toolEvents.some((event) => event.toolName === "shell")).toBe(true);

    const sessionsDir = join(baseDir, "sessions");
    const sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"));
    expect(sessionFiles.length).toBe(1);

    const sessionFile = join(sessionsDir, sessionFiles[0]!);
    const content = readFileSync(sessionFile, "utf8");
    expect(content).toContain("tool_result");
    expect(content).toContain("session_open");

    manager.shutdown();
  });

  it("starts a new session after idle timeout", () => {
    let now = new Date("2026-02-08T08:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c2");

    const first = manager.beginRun("c2", "hello");
    manager.recordAssistantFinal("c2", first.runId, first.sessionId, "hey");

    now = new Date("2026-02-08T11:05:00.000Z");
    const second = manager.beginRun("c2", "new request");

    expect(second.sessionId).not.toBe(first.sessionId);

    manager.shutdown();
  });

  it("persists previous session summary across session boundaries", () => {
    let now = new Date("2026-02-08T08:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c3");

    const first = manager.beginRun("c3", "what is 2+2");
    manager.recordAssistantFinal("c3", first.runId, first.sessionId, "4");

    now = new Date("2026-02-08T11:05:00.000Z");
    manager.beginRun("c3", "new request");

    const prompt = manager.getPromptMemoryContext();
    expect(prompt.previousSessionSummary.length).toBeGreaterThan(0);

    manager.shutdown();
  });

  it("recovers incomplete session on restart via marker file", () => {
    let now = new Date("2026-02-08T08:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager1 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager1.initialize("c4");

    const run = manager1.beginRun("c4", "hello");
    manager1.recordAssistantFinal("c4", run.runId, run.sessionId, "hey there");

    // Marker file should exist (session not closed)
    const markerPath = join(baseDir, "sessions", "active-session.txt");
    expect(existsSync(markerPath)).toBe(true);
    const markerId = readFileSync(markerPath, "utf8").trim();
    expect(markerId).toBe(run.sessionId);

    // Simulate crash — no shutdown() call

    now = new Date("2026-02-08T08:05:00.000Z");
    const manager2 = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager2.initialize("c4");

    const prompt = manager2.getPromptMemoryContext();
    expect(prompt.conversationTurns.length).toBeGreaterThanOrEqual(1);

    manager2.shutdown();
  });

  it("creates active-session.txt on session open and removes it on shutdown", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));
    const markerPath = join(baseDir, "sessions", "active-session.txt");

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c6");

    // No marker before any run
    expect(existsSync(markerPath)).toBe(false);

    const run = manager.beginRun("c6", "ping");

    // Marker should exist with the session ID
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf8").trim()).toBe(run.sessionId);

    manager.shutdown();

    // Marker should be gone after shutdown
    expect(existsSync(markerPath)).toBe(false);
  });

  it("writes JSONL events to sessions directory", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c5");

    const run = manager.beginRun("c5", "test message");
    manager.recordAssistantFinal("c5", run.runId, run.sessionId, "reply");
    manager.shutdown();

    const sessionsDir = join(baseDir, "sessions");
    expect(existsSync(sessionsDir)).toBe(true);

    const files = readdirSync(sessionsDir);
    expect(files.length).toBeGreaterThan(0);

    const content = readFileSync(join(sessionsDir, files[0]!), "utf8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBeGreaterThanOrEqual(4);

    const firstEvent = JSON.parse(lines[0]!) as { type: string };
    expect(firstEvent.type).toBe("session_open");

    const lastEvent = JSON.parse(lines[lines.length - 1]!) as { type: string };
    expect(lastEvent.type).toBe("session_close");
  });

  it("writes per-tool context JSONL on tool result", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c7");

    const run = manager.beginRun("c7", "list files");
    manager.recordToolCall("c7", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      args: { cmd: "ls -la" },
    });

    manager.recordToolResult("c7", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      status: "success",
      output: "file1.txt\nfile2.txt",
      durationMs: 15,
    });

    const contextFile = join(baseDir, "tool-context", "shell.jsonl");
    expect(existsSync(contextFile)).toBe(true);

    const content = readFileSync(contextFile, "utf8").trim();
    const entry = JSON.parse(content) as ToolContextEntry;

    expect(entry.v).toBe(1);
    expect(entry.sessionId).toBe(run.sessionId);
    expect(entry.toolCallId).toBe("tc1");
    expect(entry.args).toEqual({ cmd: "ls -la" });
    expect(entry.status).toBe("success");
    expect(entry.output).toBe("file1.txt\nfile2.txt");
    expect(entry.durationMs).toBe(15);

    manager.shutdown();
  });

  it("appends multiple invocations to the same tool context file", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c8");

    const run = manager.beginRun("c8", "do stuff");

    manager.recordToolCall("c8", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "file.read",
      args: { path: "/a.txt" },
    });
    manager.recordToolResult("c8", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "file.read",
      status: "success",
      output: "contents of a",
    });

    manager.recordToolCall("c8", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 2,
      toolCallId: "tc2",
      toolName: "file.read",
      args: { path: "/b.txt" },
    });
    manager.recordToolResult("c8", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 2,
      toolCallId: "tc2",
      toolName: "file.read",
      status: "failed",
      output: "",
      errorMessage: "Permission denied",
      errorCode: "EPERM",
      durationMs: 5,
    });

    const contextFile = join(baseDir, "tool-context", "file_read.jsonl");
    const lines = readFileSync(contextFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0]!) as ToolContextEntry;
    expect(first.toolCallId).toBe("tc1");
    expect(first.args).toEqual({ path: "/a.txt" });
    expect(first.status).toBe("success");

    const second = JSON.parse(lines[1]!) as ToolContextEntry;
    expect(second.toolCallId).toBe("tc2");
    expect(second.status).toBe("failed");
    expect(second.errorMessage).toBe("Permission denied");
    expect(second.errorCode).toBe("EPERM");

    manager.shutdown();
  });

  it("writes different tools to separate context files", () => {
    const now = new Date("2026-02-08T00:00:00.000Z");
    const baseDir = mkdtempSync(join(tmpdir(), "ayati-memory-"));

    const manager = new SessionManager({
      dbPath: join(baseDir, "memory.sqlite"),
      dataDir: baseDir,
      now: () => new Date(now),
    });

    manager.initialize("c9");

    const run = manager.beginRun("c9", "multi tool");

    manager.recordToolCall("c9", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      args: { cmd: "echo hi" },
    });
    manager.recordToolResult("c9", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 1,
      toolCallId: "tc1",
      toolName: "shell",
      status: "success",
      output: "hi",
    });

    manager.recordToolCall("c9", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 2,
      toolCallId: "tc2",
      toolName: "file.read",
      args: { path: "/x.txt" },
    });
    manager.recordToolResult("c9", {
      runId: run.runId,
      sessionId: run.sessionId,
      stepId: 2,
      toolCallId: "tc2",
      toolName: "file.read",
      status: "success",
      output: "x contents",
    });

    const shellFile = join(baseDir, "tool-context", "shell.jsonl");
    const fileReadFile = join(baseDir, "tool-context", "file_read.jsonl");

    expect(existsSync(shellFile)).toBe(true);
    expect(existsSync(fileReadFile)).toBe(true);

    const shellLines = readFileSync(shellFile, "utf8").trim().split("\n");
    const fileLines = readFileSync(fileReadFile, "utf8").trim().split("\n");

    expect(shellLines.length).toBe(1);
    expect(fileLines.length).toBe(1);

    expect((JSON.parse(shellLines[0]!) as ToolContextEntry).toolCallId).toBe("tc1");
    expect((JSON.parse(fileLines[0]!) as ToolContextEntry).toolCallId).toBe("tc2");

    manager.shutdown();
  });
});
