import { execFile } from "node:child_process";
import { cpus, hostname, totalmem } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { LlmProvider } from "../core/contracts/provider.js";
import { canonicalHash, sha256Text } from "./canonical.js";
import type {
  EvaluationCaptureMode,
  LiveEvaluationSession,
} from "./contracts.js";
import { LiveEvaluationRecorder } from "./recorder.js";
import { sanitizeEvaluationValue } from "./redaction.js";
import {
  getActiveEvaluationRecorder,
  setActiveEvaluationRecorder,
} from "./capture-runtime.js";
import { EvaluationStorage } from "./storage.js";

const execFileAsync = promisify(execFile);
const VALID_EVALUATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export async function startLiveEvaluationCapture(input: {
  projectRoot: string;
  configuredRuntimeRoot: string;
  provider: LlmProvider;
  model?: string;
  runtimeConfig: unknown;
  llmConfig: unknown;
  env?: NodeJS.ProcessEnv;
}): Promise<LiveEvaluationRecorder | undefined> {
  const env = input.env ?? process.env;
  const evaluationId = env["AYATI_EVALUATION_ID"]?.trim();
  if (!evaluationId) return undefined;
  if (!VALID_EVALUATION_ID.test(evaluationId)) {
    throw new Error(`Invalid AYATI_EVALUATION_ID: ${evaluationId}`);
  }
  const capture = parseCaptureMode(env["AYATI_EVALUATION_CAPTURE"]);
  const evaluationRoot = resolve(
    env["AYATI_EVALUATION_ROOT"]?.trim()
      || resolve(input.projectRoot, "data", "evaluations"),
  );
  const storage = new EvaluationStorage(evaluationRoot, evaluationId, capture);
  await storage.initialize();
  const repository = await readRepositoryFingerprint(input.projectRoot);
  const sanitizedConfig = sanitizeEvaluationValue({
    runtime: input.runtimeConfig,
    llm: input.llmConfig,
  }, "full", env);
  const session: LiveEvaluationSession = {
    schemaVersion: 1,
    evaluationId,
    name: env["AYATI_EVALUATION_NAME"]?.trim() || evaluationId,
    command: env["AYATI_EVALUATION_COMMAND"]?.trim() || "pnpm eval:agent -- live",
    capture,
    evidenceDirectory: storage.evaluationDirectory,
    configuredRuntimeRoot: input.configuredRuntimeRoot,
    repository,
    runtime: {
      provider: input.provider.name,
      providerVersion: input.provider.version,
      ...(input.model ? { model: input.model } : {}),
      configVersion: "live-evaluation-v1/context-engine-v7",
      configFingerprint: canonicalHash(sanitizedConfig),
    },
    machine: {
      hostname: hostname(),
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
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
  const recorder = new LiveEvaluationRecorder(storage, session);
  setActiveEvaluationRecorder(recorder);
  await storage.writeAtomic("session.json", session);
  recorder.record({
    stage: "evaluation",
    event: "started",
    data: {
      evaluationId,
      capture,
      configuredRuntimeRoot: input.configuredRuntimeRoot,
      provider: input.provider.name,
      model: input.model,
    },
  });
  return recorder;
}

export async function stopLiveEvaluationCapture(
  recorder: LiveEvaluationRecorder | undefined,
  status: "completed" | "interrupted" | "failed" = "completed",
): Promise<void> {
  if (!recorder) return;
  try {
    recorder.record({ stage: "evaluation", event: "stopped", data: { status } });
    await recorder.close(status);
  } finally {
    if (recorder === getActiveEvaluationRecorder()) setActiveEvaluationRecorder(undefined);
  }
}

function parseCaptureMode(value: string | undefined): EvaluationCaptureMode {
  if (!value || value === "full") return "full";
  if (value === "safe") return "safe";
  throw new Error(`Invalid evaluation capture mode "${value}". Expected full or safe.`);
}

async function readRepositoryFingerprint(root: string): Promise<LiveEvaluationSession["repository"]> {
  const [head, branch, status] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["branch", "--show-current"]),
    git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  const dirty = status.length > 0;
  return {
    root,
    ...(branch ? { branch } : {}),
    ...(head ? { head } : {}),
    dirty,
    ...(dirty ? { dirtyFingerprint: sha256Text(status) } : {}),
  };
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch {
    return "";
  }
}
