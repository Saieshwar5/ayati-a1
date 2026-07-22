import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type {
  LlmTurnInput,
  LlmTurnOutput,
} from "../../src/core/contracts/llm-protocol.js";
import {
  captureProviderNativePayload,
  captureProviderNativeResponse,
  createEvaluationProvider,
  setActiveEvaluationRecorder,
  withEvaluationContext,
  withEvaluationModelOperation,
} from "../../src/evaluation/capture-runtime.js";
import type {
  LiveEvaluationSession,
  ProviderRequest,
} from "../../src/evaluation/contracts.js";
import { LiveEvaluationRecorder } from "../../src/evaluation/recorder.js";
import { EvaluationStorage } from "../../src/evaluation/storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  setActiveEvaluationRecorder(undefined);
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("live evaluation recorder instrumentation", () => {
  it("proves canonical request equality at the adapter boundary and captures usage", async () => {
    const { recorder, storage } = await createRecorder();
    const adapterInputs: LlmTurnInput[] = [];
    const provider = createEvaluationProvider(fakeProvider({ adapterInputs }));
    const input: LlmTurnInput = {
      messages: [
        { role: "system", content: "rules" },
        { role: "user", content: "hello" },
      ],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      toolChoice: "auto",
      responseFormat: { type: "json_object" },
    };

    await withEvaluationContext({
      runId: "RUN-1",
      sessionId: "STREAM-1",
      laneId: "main:RUN-1",
      attribution: "foreground",
    }, async () => await withEvaluationModelOperation({
        purpose: "main_decision",
        iteration: 1,
        compilationReceipt: { schemaVersion: 2, admitted: true },
        promptManifest: { policyVersion: 1, parts: [{ id: "current", content: "hello" }] },
      }, async () => await provider.generateTurn(input)));
    await recorder.flush();

    expect(adapterInputs).toEqual([input]);
    const request = await onlyRequest(storage);
    expect(request.observableTransportAttempts).toBe(1);
    expect(request.providerNativeResponses).toHaveLength(1);
    expect(request.sdkInternalRetryCount).toBe("not_exposed");
    expect(request.usage).toMatchObject({ inputTokens: 10, outputTokens: 4, cachedInputTokens: 3 });
    const artifact = await storage.readJson<{ value: LlmTurnInput }>(request.canonicalRequest.path);
    expect(artifact.value).toEqual(input);
    const operation = [...recorder.operations.values()][0];
    expect(operation?.compilation?.receipt).toBeDefined();
    expect(operation?.compilation?.promptManifest).toBeDefined();
  });

  it("records streaming first-token timing and the complete normalized response", async () => {
    const { recorder, storage } = await createRecorder();
    const provider = createEvaluationProvider(fakeProvider({ streaming: true }));
    const deltas: string[] = [];
    await withEvaluationContext({ runId: "RUN-STREAM", attribution: "foreground" }, async () =>
      await withEvaluationModelOperation({ purpose: "final_response" }, async () =>
        await provider.streamTurn!({ messages: [{ role: "user", content: "stream" }] }, {
          onTextDelta: (delta) => deltas.push(delta),
        })));
    await recorder.flush();
    const request = await onlyRequest(storage);
    expect(deltas).toEqual(["hello", " world"]);
    expect(request.invocation).toBe("streamTurn");
    expect(request.timeToFirstTokenMs).toBeGreaterThanOrEqual(0);
    expect(request.streamingDurationMs).toBeGreaterThanOrEqual(0);
    const response = await storage.readJson<{ value: LlmTurnOutput }>(request.normalizedResponse!.path);
    expect(response.value).toMatchObject({ type: "assistant", content: "hello world" });
  });

  it("keeps concurrent operation identities and background attribution separate", async () => {
    const { recorder } = await createRecorder();
    const provider = createEvaluationProvider(fakeProvider({}));
    await Promise.all([
      runOperation(provider, "RUN-A", "main_decision", "foreground"),
      runOperation(provider, "RUN-B", "decision_repair", "foreground"),
      runOperation(provider, "RUN-C", "provider_retry", "foreground"),
      runOperation(provider, "RUN-D", "memory_consolidation", "descendant_background"),
    ]);
    await provider.generateTurn({ messages: [{ role: "user", content: "unattributed" }] });
    await recorder.flush();

    const operations = [...recorder.operations.values()];
    expect(new Set(operations.map((item) => item.operationId)).size).toBe(5);
    expect(operations.filter((item) => item.attribution === "descendant_background")).toHaveLength(1);
    expect(operations.some((item) => item.purpose === "unclassified" && item.attribution === "background_unattributed")).toBe(true);
    expect(new Set([...recorder.requests.values()].map((item) => item.operationId)).size).toBe(5);
  });

  it("makes run reports available at a checkpoint while capture remains active", async () => {
    const { recorder, storage } = await createRecorder();
    recorder.record({
      sessionId: "STREAM-1",
      runId: "RUN-REPORT",
      stage: "message",
      event: "received",
      data: { kind: "chat", content: "hello sk-evaluation-secret-123456789" },
    });
    recorder.record({
      sessionId: "STREAM-1",
      runId: "RUN-REPORT",
      stage: "context_engine",
      event: "run_finalization_completed",
      data: { outcome: "done", stopReason: "completed", contextRevision: "rev-2" },
    });
    recorder.record({
      sessionId: "STREAM-1",
      runId: "RUN-REPORT",
      stage: "final",
      event: "dispatched",
      data: { type: "reply", status: "completed", stopReason: "completed", content: "hi" },
    });
    await recorder.checkpoint("RUN-REPORT");
    await storage.writeAtomic("runs/RUN-REPORT/annotations.json", {
      schemaVersion: 1,
      evaluationId: recorder.session.evaluationId,
      runId: "RUN-REPORT",
      updatedAt: new Date().toISOString(),
      scenarioLabel: "report-annotation",
      codingAgentConclusions: "The terminal evidence is useful.",
      suggestedExperiments: ["Repeat with a longer context."],
    });
    await recorder.checkpoint("RUN-REPORT");
    const report = await readFile(storage.path("runs", "RUN-REPORT", "report.md"), "utf8");
    expect(report).toContain("Live evaluation run RUN-REPORT");
    expect(report).toContain("Terminal type: reply");
    expect(report).not.toContain("sk-evaluation-secret-123456789");
    const reportPath = storage.path("runs", "RUN-REPORT", "report.md");
    const links = [...report.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]!);
    for (const link of links) await expect(stat(resolve(dirname(reportPath), link))).resolves.toBeDefined();
    const sessionReport = await readFile(storage.path("session-report.md"), "utf8");
    expect(sessionReport).toContain("Scenario: report-annotation");
    expect(sessionReport).toContain("Conclusions: The terminal evidence is useful.");
    expect(sessionReport).toContain("- Repeat with a longer context.");
    const sessionJson = await storage.readJson<{ annotations: Array<{ runId: string }> }>("session-report.json");
    expect(sessionJson.annotations).toEqual([expect.objectContaining({ runId: "RUN-REPORT" })]);
    expect(recorder.session.status).toBe("running");
  });

  it("schedules terminal reports behind queued capture without blocking the caller", async () => {
    const { recorder, storage } = await createRecorder();
    let release!: () => void;
    const pending = new Promise<void>((resolvePending) => { release = resolvePending; });
    const appendEventLine = storage.appendEventLine.bind(storage);
    vi.spyOn(storage, "appendEventLine").mockImplementationOnce(async (event) => {
      await pending;
      await appendEventLine(event);
    });
    recorder.record({
      sessionId: "STREAM-ASYNC",
      runId: "RUN-ASYNC",
      stage: "final",
      event: "dispatched",
      data: { type: "reply", status: "completed", stopReason: "completed", content: "done" },
    });

    expect(recorder.scheduleCheckpoint("RUN-ASYNC")).toBeUndefined();
    expect(await fileExists(storage.path("runs", "RUN-ASYNC", "report.md"))).toBe(false);

    release();
    await recorder.flush();
    expect(await fileExists(storage.path("runs", "RUN-ASYNC", "report.md"))).toBe(true);
  });

  it("degrades capture without failing the observed operation", async () => {
    const { recorder, storage } = await createRecorder();
    vi.spyOn(storage, "appendEventLine").mockRejectedValueOnce(new Error("disk unavailable"));
    recorder.record({ stage: "test", event: "completed", data: { value: 1 } });
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(recorder.session.captureHealth.status).toBe("degraded");
    expect(recorder.session.captureHealth.failedWrites).toBe(1);
    expect(recorder.session.captureHealth.gaps[0]?.message).toContain("disk unavailable");
  });

  it("flushes interrupted sessions and leaves disabled mode artifact-free", async () => {
    const { recorder, storage } = await createRecorder();
    recorder.record({ runId: "RUN-SIGNAL", stage: "test", event: "completed" });
    await recorder.close("interrupted");
    expect((await storage.readJson<LiveEvaluationSession>("session.json")).status).toBe("interrupted");
    expect((await storage.readJson<{ runId?: string }>("latest.json")).runId).toBe("RUN-SIGNAL");

    setActiveEvaluationRecorder(undefined);
    const provider = fakeProvider({});
    expect(createEvaluationProvider(provider)).toBe(provider);
    let called = false;
    await withEvaluationModelOperation({ purpose: "main_decision" }, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});

async function runOperation(
  provider: LlmProvider,
  runId: string,
  purpose: "main_decision" | "decision_repair" | "provider_retry" | "memory_consolidation",
  attribution: "foreground" | "descendant_background",
): Promise<void> {
  await withEvaluationContext({ runId, laneId: `main:${runId}`, attribution }, async () =>
    await withEvaluationModelOperation({ purpose }, async () => {
      await provider.generateTurn({ messages: [{ role: "user", content: runId }] });
    }));
}

function fakeProvider(options: {
  adapterInputs?: LlmTurnInput[];
  streaming?: boolean;
}): LlmProvider {
  const output: LlmTurnOutput = {
    type: "assistant",
    content: "hello world",
    usage: {
      provider: "fixture",
      model: "fixture-model",
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cachedInputTokens: 3,
      exact: true,
    },
    cost: {
      currency: "USD",
      inputCostUsd: 0.001,
      cachedInputCostUsd: 0.0001,
      outputCostUsd: 0.002,
      totalCostUsd: 0.0031,
      pricingSource: "fixture",
    },
  };
  return {
    name: "fixture",
    version: "1.0.0",
    capabilities: { nativeToolCalling: true, streaming: options.streaming === true },
    start(): void {},
    stop(): void {},
    async generateTurn(input) {
      options.adapterInputs?.push(structuredClone(input));
      captureProviderNativePayload({
        provider: "fixture",
        operation: "generateTurn",
        payload: { model: "fixture-model", messages: input.messages, tools: input.tools },
      });
      captureProviderNativeResponse({
        provider: "fixture",
        operation: "generateTurn",
        response: { id: "native-fixture", usage: output.usage },
      });
      return structuredClone(output);
    },
    ...(options.streaming
      ? {
          async streamTurn(input, callbacks) {
            options.adapterInputs?.push(structuredClone(input));
            captureProviderNativePayload({
              provider: "fixture",
              operation: "streamTurn",
              payload: { model: "fixture-model", stream: true, messages: input.messages },
            });
            captureProviderNativeResponse({
              provider: "fixture",
              operation: "streamTurn",
              response: { chunks: [{ delta: "hello" }, { delta: " world" }], usage: output.usage },
            });
            callbacks.onTextDelta?.("hello");
            callbacks.onTextDelta?.(" world");
            return structuredClone(output);
          },
        }
      : {}),
  };
}

async function createRecorder(): Promise<{ recorder: LiveEvaluationRecorder; storage: EvaluationStorage }> {
  const root = await mkdtemp(join(tmpdir(), "ayati-evaluation-recorder-"));
  temporaryDirectories.push(root);
  const storage = new EvaluationStorage(root, "eval-test", "full");
  await storage.initialize();
  const session = sessionFixture(storage);
  const recorder = new LiveEvaluationRecorder(storage, session);
  setActiveEvaluationRecorder(recorder);
  return { recorder, storage };
}

function sessionFixture(storage: EvaluationStorage): LiveEvaluationSession {
  return {
    schemaVersion: 1,
    evaluationId: storage.evaluationId,
    name: "instrumentation fixture",
    command: "vitest instrumentation fixture",
    capture: storage.capture,
    evidenceDirectory: storage.evaluationDirectory,
    configuredRuntimeRoot: "/tmp/ayati-fixture",
    repository: { root: "/tmp/repo", dirty: false },
    runtime: {
      provider: "fixture",
      providerVersion: "1.0.0",
      model: "fixture-model",
      configVersion: "fixture",
      configFingerprint: "abc",
    },
    machine: {
      hostname: "fixture",
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      cpuCount: 1,
      totalMemoryBytes: 1,
      pid: process.pid,
    },
    startedAt: new Date().toISOString(),
    status: "running",
    captureHealth: {
      status: "healthy",
      queuedWrites: 0,
      completedWrites: 0,
      failedWrites: 0,
      droppedEvents: 0,
      recorderOverheadMs: 0,
      gaps: [],
    },
  };
}

async function onlyRequest(storage: EvaluationStorage): Promise<ProviderRequest> {
  const files = (await readdir(storage.path("requests"))).filter((name) => name.endsWith(".json"));
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(storage.path("requests", files[0]!), "utf8")) as ProviderRequest;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
