import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveEvaluationRecorder } from "../../src/evaluation/capture-runtime.js";
import type { LiveEvaluationSession } from "../../src/evaluation/contracts.js";
import { LiveEvaluationRecorder } from "../../src/evaluation/recorder.js";
import { EvaluationStorage } from "../../src/evaluation/storage.js";
import { createEvaluationToolExecutor } from "../../src/evaluation/tool-capture.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setActiveEvaluationRecorder(undefined);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("evaluation tool capture", () => {
  it("records exact inputs, raw textual outputs, assertions, and duration", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-evaluation-tool-"));
    temporaryDirectories.push(root);
    const storage = new EvaluationStorage(root, "eval-tool", "full");
    await storage.initialize();
    const recorder = new LiveEvaluationRecorder(storage, sessionFixture(storage));
    setActiveEvaluationRecorder(recorder);
    const executor = createEvaluationToolExecutor(createToolExecutor([{
      name: "fixture_read",
      description: "fixture",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
      async execute(input) {
        return {
          ok: true,
          output: "projected output",
          rawOutput: "exact raw output\nline two",
          v2: {
            schemaVersion: 2,
            status: "success",
            output: { text: "projected output" },
            verification: {
              facts: [],
              assertions: [{ id: "exists", status: "passed", severity: "required", message: "exists" }],
            },
          },
        };
      },
    }]));
    const result = await executor.execute("fixture_read", { path: "/tmp/input.txt" }, {
      clientId: "local",
      sessionId: "STREAM-1",
      runId: "RUN-TOOL",
      callId: "CALL-1",
      stepNumber: 1,
    });
    expect(result.ok).toBe(true);
    await recorder.flush();
    const events = (await readFile(storage.path("events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    const completed = events.find((event) => event.component === "tool" && event.event === "completed");
    expect(completed.runId).toBe("RUN-TOOL");
    expect(completed.durationMs).toBeGreaterThanOrEqual(0);
    const rawArtifact = completed.artifacts.find((artifact: { kind: string }) => artifact.kind.endsWith("rawOutput"));
    const envelope = JSON.parse(await readFile(storage.path(rawArtifact.path), "utf8"));
    expect(envelope.value).toBe("exact raw output\nline two");
  });
});

function sessionFixture(storage: EvaluationStorage): LiveEvaluationSession {
  return {
    schemaVersion: 1,
    evaluationId: storage.evaluationId,
    name: "tool fixture",
    command: "vitest",
    capture: "full",
    evidenceDirectory: storage.evaluationDirectory,
    configuredRuntimeRoot: "/tmp/root",
    repository: { root: "/tmp/repo", dirty: false },
    runtime: { provider: "fixture", providerVersion: "1", configVersion: "1", configFingerprint: "1" },
    machine: { hostname: "fixture", platform: process.platform, architecture: process.arch, nodeVersion: process.version, cpuCount: 1, totalMemoryBytes: 1, pid: process.pid },
    startedAt: new Date().toISOString(),
    status: "running",
    captureHealth: { status: "healthy", queuedWrites: 0, completedWrites: 0, failedWrites: 0, droppedEvents: 0, recorderOverheadMs: 0, gaps: [] },
  };
}
