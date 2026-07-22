import { describe, expect, it } from "vitest";
import {
  canonicalHash,
  canonicalStringify,
} from "../../src/evaluation/canonical.js";
import {
  containsRecognizedSecret,
  sanitizeEvaluationValue,
} from "../../src/evaluation/redaction.js";
import {
  isEvaluationEvent,
  isEvaluationFinding,
  isLiveEvaluationSession,
  isModelOperation,
  isProviderRequest,
} from "../../src/evaluation/contracts.js";

describe("evaluation canonicalization and redaction", () => {
  it("produces stable canonical hashes independent of object key order", () => {
    const left = { z: [3, { b: true, a: "x" }], a: 1 };
    const right = { a: 1, z: [3, { a: "x", b: true }] };
    expect(canonicalStringify(left)).toBe(canonicalStringify(right));
    expect(canonicalHash(left)).toBe(canonicalHash(right));
  });

  it("redacts credential keys, inline tokens, and known environment secrets", () => {
    const secret = "sk-example-secret-1234567890";
    const value = sanitizeEvaluationValue({
      apiKey: secret,
      authorization: `Bearer ${secret}`,
      prompt: `Use ${secret} but keep inputTokens=12`,
      inputTokens: 12,
    }, "full", { OPENAI_API_KEY: secret });
    const text = JSON.stringify(value);
    expect(text).not.toContain(secret);
    expect(text).toContain("redacted");
    expect(text).toContain("inputTokens");
    expect(containsRecognizedSecret(value)).toBe(false);
  });

  it("uses hashes and bounded previews in safe capture", () => {
    const value = sanitizeEvaluationValue({ prompt: "x".repeat(500) }, "safe", {});
    expect(value).toMatchObject({
      prompt: {
        safeCapture: true,
        length: 500,
      },
    });
  });

  it("omits large encoded binary content without losing identity", () => {
    const value = sanitizeEvaluationValue({ image: "A".repeat(5_000) }, "full", {});
    expect(value).toMatchObject({
      image: {
        binaryContentOmitted: true,
        encodedLength: 5_000,
      },
    });
  });

  it("validates the required schema identities", () => {
    const artifact = {
      artifactId: "artifact-1",
      sha256: "abc",
      path: "artifacts/abc.json",
      kind: "fixture",
      mediaType: "application/json",
      sizeBytes: 1,
      capture: "full",
    };
    expect(isLiveEvaluationSession({
      schemaVersion: 1,
      evaluationId: "eval-1",
      name: "test",
      command: "pnpm eval:agent -- live",
      capture: "full",
      evidenceDirectory: "/tmp/eval-1",
      configuredRuntimeRoot: "/tmp/ayati",
      repository: { root: "/tmp/repo" },
      runtime: { provider: "fixture" },
      machine: { nodeVersion: process.version },
      startedAt: new Date().toISOString(),
      status: "running",
      captureHealth: { status: "healthy" },
    })).toBe(true);
    expect(isEvaluationEvent({
      schemaVersion: 1,
      eventId: "EVT-1",
      evaluationId: "eval-1",
      component: "test",
      event: "done",
      timestamp: new Date().toISOString(),
      timestampMs: Date.now(),
      monotonicNs: "1",
      attribution: "foreground",
      artifacts: [],
    })).toBe(true);
    expect(isProviderRequest({
      schemaVersion: 1,
      requestId: "REQ-1",
      operationId: "OP-1",
      purpose: "main_decision",
      attribution: "foreground",
      provider: "test",
      providerVersion: "1",
      invocation: "generateTurn",
      startedAt: new Date().toISOString(),
      canonicalRequest: artifact,
      providerNativePayloads: [],
      providerNativeResponses: [],
      observableTransportAttempts: 0,
      sdkInternalRetryCount: "not_exposed",
      outcome: "running",
    })).toBe(true);
    expect(isModelOperation({
      schemaVersion: 1,
      evaluationId: "eval-1",
      operationId: "OP-1",
      purpose: "main_decision",
      attribution: "foreground",
      foreground: true,
      startedAt: new Date().toISOString(),
      providerRequestIds: [],
      terminalOutcome: "running",
    })).toBe(true);
    expect(isEvaluationFinding({
      schemaVersion: 1,
      code: "FIXTURE",
      severity: "info",
      confidence: "high",
      affectedEvidence: [],
      likelySubsystem: "fixture",
      observedFact: "fact",
      diagnosticGuidance: "inspect",
    })).toBe(true);
    expect(isProviderRequest({ schemaVersion: 2 })).toBe(false);
    expect(isLiveEvaluationSession({ schemaVersion: 1, evaluationId: "incomplete" })).toBe(false);
  });
});
