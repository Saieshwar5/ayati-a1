import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import {
  readFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  EvaluationAnnotation,
  EvaluationCaptureMode,
  LiveEvaluationSession,
} from "./contracts.js";
import { compareEvaluations, generateEvaluationReports } from "./reporting.js";
import { EvaluationStorage, assertContained, safeSegment } from "./storage.js";
import {
  executeEvaluationPrune,
  planEvaluationPrune,
} from "./prune.js";

const projectRoot = resolve(dirname(import.meta.dirname), "..", "..");
const evaluationRoot = resolve(projectRoot, "ayati-main", "data", "evaluations");

await main(process.argv.slice(2).filter((value, index) => !(value === "--" && index === 0)));

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  switch (command) {
    case "live":
      await live(options);
      return;
    case "inspect":
      await inspect(options);
      return;
    case "annotate":
      await annotate(options);
      return;
    case "report":
      await report(options);
      return;
    case "compare":
      await compare(options);
      return;
    case "prune":
      await prune(options);
      return;
    default:
      throw new Error(usage(command));
  }
}

async function live(options: CliOptions): Promise<void> {
  const name = stringOption(options, "name") ?? "live-agent-evaluation";
  const capture = captureOption(options);
  const evaluationId = createEvaluationId(name);
  const storage = new EvaluationStorage(evaluationRoot, evaluationId, capture);
  await storage.initialize();
  const websocketAddress = `ws://localhost:${process.env["AYATI_WS_PORT"] ?? "8080"}`;
  const command = options.flags.has("watch")
    ? "pnpm --filter ayati-main dev"
    : "node --env-file-if-exists=.env ayati-main/dist/index.js";
  process.stdout.write([
    `Evaluation ID: ${evaluationId}`,
    `WebSocket: ${websocketAddress}`,
    `Evidence: ${storage.evaluationDirectory}`,
    `Capture: ${capture}`,
    "",
  ].join("\n"));

  const child = options.flags.has("watch")
    ? spawn("pnpm", ["--filter", "ayati-main", "dev"], childOptions(evaluationId, name, capture, command))
    : spawn(process.execPath, ["--env-file-if-exists=.env", "ayati-main/dist/index.js"], childOptions(evaluationId, name, capture, command));
  let forwardedSignal: NodeJS.Signals | undefined;
  const forward = (signal: NodeJS.Signals): void => {
    forwardedSignal = signal;
    signalChild(child, signal);
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);
  process.once("SIGHUP", forward);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult) => {
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
    child.once("error", (error) => {
      process.stderr.write(`Unable to start Ayati daemon: ${error.message}\n`);
      resolveResult({ code: 1, signal: null });
    });
  });
  process.removeListener("SIGINT", forward);
  process.removeListener("SIGTERM", forward);
  process.removeListener("SIGHUP", forward);
  await recoverExitedSession(storage, forwardedSignal || result.signal ? "signal" : `exit_${result.code ?? "unknown"}`);
  if (forwardedSignal || result.signal) return;
  if (result.code && result.code !== 0) process.exitCode = result.code;
}

async function inspect(options: CliOptions): Promise<void> {
  const evaluationId = await resolveEvaluationId(options);
  const storage = await openStorage(evaluationId);
  const run = stringOption(options, "run") ?? (options.flags.has("latest") ? await latestRun(storage) : undefined);
  const path = run
    ? storage.path("runs", safeSegment(run), "report.md")
    : storage.path("session-report.md");
  process.stdout.write(await readFile(path, "utf8"));
}

async function annotate(options: CliOptions): Promise<void> {
  const evaluationId = await resolveEvaluationId(options);
  const storage = await openStorage(evaluationId);
  const runId = stringOption(options, "run") ?? await latestRun(storage);
  const annotation: EvaluationAnnotation = {
    schemaVersion: 1,
    evaluationId,
    ...(runId ? { runId } : {}),
    updatedAt: new Date().toISOString(),
    ...(stringOption(options, "intended-outcome") ? { intendedOutcome: stringOption(options, "intended-outcome") } : {}),
    ...(stringOption(options, "usefulness") ? { observedUsefulness: stringOption(options, "usefulness") } : {}),
    ...(stringOption(options, "suspected-issue") ? { suspectedIssue: stringOption(options, "suspected-issue") } : {}),
    ...(stringOption(options, "user-feedback") ? { userFeedback: stringOption(options, "user-feedback") } : {}),
    ...(stringOption(options, "scenario") ? { scenarioLabel: stringOption(options, "scenario") } : {}),
    ...(stringOption(options, "conclusions") ? { codingAgentConclusions: stringOption(options, "conclusions") } : {}),
    ...(options.multi.get("experiment")?.length ? { suggestedExperiments: options.multi.get("experiment") } : {}),
  };
  if (!annotation.intendedOutcome
    && !annotation.observedUsefulness
    && !annotation.suspectedIssue
    && !annotation.userFeedback
    && !annotation.scenarioLabel
    && !annotation.codingAgentConclusions
    && !annotation.suggestedExperiments?.length) {
    throw new Error("annotate requires at least one annotation flag");
  }
  if (runId) {
    await storage.ensureRun(runId);
    await storage.writeAtomic(`runs/${safeSegment(runId)}/annotations.json`, annotation);
  } else {
    await storage.writeAtomic("annotations.json", annotation);
  }
  const session = await storage.readJson<LiveEvaluationSession>("session.json");
  await generateEvaluationReports({ storage, session, ...(runId ? { runId } : {}) });
  process.stdout.write(`Updated annotation for ${runId ?? evaluationId}.\n`);
}

async function report(options: CliOptions): Promise<void> {
  const evaluationId = await resolveEvaluationId(options);
  const storage = await openStorage(evaluationId);
  const session = await storage.readJson<LiveEvaluationSession>("session.json");
  if (session.status === "running" && !processIsAlive(session.machine.pid)) {
    markExitedSessionDegraded(session, "report_detected_dead_daemon");
  }
  await generateEvaluationReports({ storage, session });
  process.stdout.write(await readFile(storage.path("session-report.md"), "utf8"));
}

async function compare(options: CliOptions): Promise<void> {
  const baselineId = requiredOption(options, "baseline");
  const candidateId = requiredOption(options, "candidate");
  const baseline = await openStorage(baselineId);
  const candidate = await openStorage(candidateId);
  const comparison = await compareEvaluations({ baseline, candidate });
  await candidate.writeAtomic(`comparison-${safeSegment(baselineId)}.json`, comparison);
  const session = await candidate.readJson<LiveEvaluationSession>("session.json");
  await generateEvaluationReports({ storage: candidate, session });
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
}

async function prune(options: CliOptions): Promise<void> {
  const olderThanDays = numberOption(options, "older-than");
  const keep = numberOption(options, "keep");
  if (olderThanDays === undefined && keep === undefined) {
    throw new Error("prune requires --older-than <days> or --keep <count>");
  }
  const targets = await planEvaluationPrune({
    evaluationRoot,
    ...(olderThanDays !== undefined ? { olderThanDays } : {}),
    ...(keep !== undefined ? { keep } : {}),
  });
  process.stdout.write([
    options.flags.has("confirm") ? "Confirmed evaluation prune:" : "Evaluation prune preview (no files removed):",
    ...targets.map((item) => `- ${item.evaluationId}: ${item.path} (${item.sizeBytes} bytes)`),
    targets.length === 0 ? "- no matching evaluations" : "",
  ].join("\n"));
  if (!options.flags.has("confirm")) return;
  await executeEvaluationPrune(evaluationRoot, targets);
}

interface CliOptions {
  values: Map<string, string>;
  multi: Map<string, string[]>;
  flags: Set<string>;
}

function parseOptions(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const item = args[index]!;
    if (!item.startsWith("--")) throw new Error(`Unexpected argument: ${item}`);
    const key = item.slice(2);
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      flags.add(key);
      continue;
    }
    values.set(key, next);
    multi.set(key, [...(multi.get(key) ?? []), next]);
    index++;
  }
  return { values, multi, flags };
}

function childOptions(evaluationId: string, name: string, capture: EvaluationCaptureMode, command: string) {
  return {
    cwd: projectRoot,
    stdio: "inherit" as const,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      AYATI_EVALUATION_ID: evaluationId,
      AYATI_EVALUATION_NAME: name,
      AYATI_EVALUATION_CAPTURE: capture,
      AYATI_EVALUATION_ROOT: evaluationRoot,
      AYATI_EVALUATION_COMMAND: command,
      AYATI_LIVE_EVALUATION: "1",
    },
  };
}

function signalChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall through if the detached process group has already exited.
    }
  }
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

async function openStorage(evaluationId: string): Promise<EvaluationStorage> {
  const sessionPath = resolve(evaluationRoot, evaluationId, "session.json");
  assertContained(evaluationRoot, sessionPath);
  const session = JSON.parse(await readFile(sessionPath, "utf8")) as LiveEvaluationSession;
  return new EvaluationStorage(evaluationRoot, evaluationId, session.capture);
}

async function resolveEvaluationId(options: CliOptions): Promise<string> {
  const explicit = stringOption(options, "evaluation");
  if (explicit) return explicit;
  if (!options.flags.has("latest")) throw new Error("--evaluation <id> is required (or use --latest)");
  const latest = JSON.parse(await readFile(resolve(evaluationRoot, "latest.json"), "utf8")) as { evaluationId?: string };
  if (!latest.evaluationId) throw new Error("latest evaluation pointer has no evaluationId");
  return latest.evaluationId;
}

async function latestRun(storage: EvaluationStorage): Promise<string | undefined> {
  try {
    const latest = await storage.readJson<{ runId?: string }>("latest.json");
    return latest.runId;
  } catch {
    return undefined;
  }
}

function captureOption(options: CliOptions): EvaluationCaptureMode {
  const value = stringOption(options, "capture") ?? "full";
  if (value !== "full" && value !== "safe") throw new Error("--capture must be full or safe");
  return value;
}

function stringOption(options: CliOptions, name: string): string | undefined {
  return options.values.get(name);
}

function requiredOption(options: CliOptions, name: string): string {
  const value = stringOption(options, name);
  if (!value) throw new Error(`--${name} <value> is required`);
  return value;
}

function numberOption(options: CliOptions, name: string): number | undefined {
  const raw = stringOption(options, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

function createEvaluationId(name: string): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "evaluation";
  return `${timestamp}-${slug}-${randomBytes(3).toString("hex")}`;
}

async function recoverExitedSession(storage: EvaluationStorage, reason: string): Promise<void> {
  try {
    const session = await storage.readJson<LiveEvaluationSession>("session.json");
    if (session.status !== "running") return;
    markExitedSessionDegraded(session, reason);
    await generateEvaluationReports({ storage, session });
  } catch (error) {
    process.stderr.write(`Unable to finalize exited evaluation capture: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function markExitedSessionDegraded(session: LiveEvaluationSession, reason: string): void {
  session.endedAt = new Date().toISOString();
  session.status = "degraded";
  session.captureHealth.status = "degraded";
  session.captureHealth.gaps.push({
    at: session.endedAt,
    component: "evaluation_process",
    operation: "session_shutdown",
    message: `The daemon exited before the recorder finalized the session (${reason}).`,
  });
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function usage(command?: string): string {
  return [
    command ? `Unknown evaluation command: ${command}` : "Missing evaluation command.",
    "Usage:",
    "  pnpm eval:agent -- live --name <name> [--watch] [--capture full|safe]",
    "  pnpm eval:agent -- inspect --evaluation <id> [--run <run-id>|--latest]",
    "  pnpm eval:agent -- annotate --evaluation <id> [--run <run-id>] [annotation flags]",
    "  pnpm eval:agent -- report --evaluation <id>",
    "  pnpm eval:agent -- compare --baseline <id> --candidate <id>",
    "  pnpm eval:agent -- prune [--older-than <days>|--keep <count>] [--confirm]",
  ].join("\n");
}
