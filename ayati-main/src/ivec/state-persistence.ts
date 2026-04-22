import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopState, ActOutput, ActToolCallRecord, VerifyOutput } from "./types.js";

type PersistedLoopState = Omit<
  LoopState,
  "sessionHistory" | "recentRunLedgers" | "recentTaskSummaries" | "activeSessionAttachments" | "recentSystemActivity"
>;
const runArtifactWriteQueues = new Map<string, Promise<void>>();
const runStateWriteQueues = new Map<string, RunStateWriteQueue>();
let tempFileCounter = 0;

interface RunStateWriteQueue {
  inFlight: Promise<void> | null;
  pendingContent: string | null;
}

export function initRunDirectory(dataDir: string, runId: string): string {
  const runPath = join(dataDir, "runs", runId);
  mkdirSync(join(runPath, "steps"), { recursive: true });
  return runPath;
}

export function writeJSON(runPath: string, filename: string, data: unknown): void {
  const filePath = join(runPath, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function writeState(runPath: string, state: LoopState): void {
  writeJSON(runPath, "state.json", buildPersistedLoopState(state));
}

export function queueStateWrite(runPath: string, state: LoopState): Promise<void> {
  const content = `${JSON.stringify(buildPersistedLoopState(state), null, 2)}\n`;
  const queue = runStateWriteQueues.get(runPath) ?? {
    inFlight: null,
    pendingContent: null,
  };

  queue.pendingContent = content;
  if (!runStateWriteQueues.has(runPath)) {
    runStateWriteQueues.set(runPath, queue);
  }

  if (!queue.inFlight) {
    queue.inFlight = drainStateWrites(runPath, queue);
  }

  return queue.inFlight;
}

export async function flushStateWrites(runPath: string): Promise<void> {
  while (true) {
    const inFlight = runStateWriteQueues.get(runPath)?.inFlight;
    if (!inFlight) {
      return;
    }
    await inFlight;
  }
}

export function writeStepMarkdown(runPath: string, filename: string, content: string): void {
  const filePath = join(runPath, filename);
  writeFileSync(filePath, content, "utf-8");
}

export function queueStepMarkdownWrite(runPath: string, filename: string, content: string): Promise<void> {
  return enqueueRunArtifactWrite(runPath, async () => {
    const filePath = join(runPath, filename);
    await writeTextFileAtomic(filePath, content);
  });
}

export async function writeStepArtifactText(runPath: string, filename: string, content: string): Promise<void> {
  const filePath = join(runPath, filename);
  await writeTextFileAtomic(filePath, content);
}

export function readState(runPath: string): Partial<LoopState> | null {
  const filePath = join(runPath, "state.json");
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as Partial<LoopState>;
  if (parsed && typeof parsed === "object") {
    delete (parsed as Record<string, unknown>)["sessionHistory"];
    delete (parsed as Record<string, unknown>)["recentRunLedgers"];
    delete (parsed as Record<string, unknown>)["recentTaskSummaries"];
    delete (parsed as Record<string, unknown>)["activeSessionAttachments"];
    delete (parsed as Record<string, unknown>)["recentSystemActivity"];
    normalizeLegacyLoopState(parsed);
  }
  return parsed;
}

function normalizeLegacyLoopState(parsed: Partial<LoopState>): void {
  if (Array.isArray(parsed.completedSteps)) {
    parsed.completedSteps = parsed.completedSteps.map((step) => {
      const legacy = step as typeof step & { intent?: string };
      return {
        ...step,
        executionContract: step.executionContract ?? legacy.intent ?? "",
      };
    });
  }

  if (Array.isArray(parsed.failedApproaches)) {
    parsed.failedApproaches = parsed.failedApproaches.map((failure) => {
      const legacy = failure as typeof failure & { intent?: string };
      return {
        ...failure,
        executionContract: failure.executionContract ?? legacy.intent ?? "",
      };
    });
  }
}

function buildPersistedLoopState(state: LoopState): PersistedLoopState {
  const {
    sessionHistory: _sessionHistory,
    recentRunLedgers: _recentRunLedgers,
    recentTaskSummaries: _recentTaskSummaries,
    activeSessionAttachments: _activeSessionAttachments,
    recentSystemActivity: _recentSystemActivity,
    ...persisted
  } = state;
  return {
    ...persisted,
    completedSteps: persisted.completedSteps.map((step) => sanitizeStepSummary(step)),
  };
}

function enqueueRunArtifactWrite(runPath: string, task: () => Promise<void>): Promise<void> {
  const previous = runArtifactWriteQueues.get(runPath) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task);
  const settled = next.finally(() => {
    if (runArtifactWriteQueues.get(runPath) === settled) {
      runArtifactWriteQueues.delete(runPath);
    }
  });
  runArtifactWriteQueues.set(runPath, settled);
  return settled;
}

async function drainStateWrites(runPath: string, queue: RunStateWriteQueue): Promise<void> {
  const filePath = join(runPath, "state.json");

  try {
    while (queue.pendingContent !== null) {
      const content = queue.pendingContent;
      queue.pendingContent = null;
      await writeTextFileAtomic(filePath, content);
    }
  } finally {
    queue.inFlight = null;
    if (queue.pendingContent !== null) {
      queue.inFlight = drainStateWrites(runPath, queue);
      return;
    }

    if (runStateWriteQueues.get(runPath) === queue) {
      runStateWriteQueues.delete(runPath);
    }
  }
}

async function writeTextFileAtomic(filePath: string, content: string): Promise<void> {
  tempFileCounter += 1;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${tempFileCounter}.tmp`;
  await writeFile(tempPath, content, "utf-8");
  await rename(tempPath, filePath);
}

// --- Markdown formatters ---

function summarizeValue(value: unknown, maxLen = 300): string {
  if (typeof value === "string") {
    return value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;
  }
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
  } catch {
    return String(value);
  }
}

export function formatActMarkdown(data: ActOutput): string {
  const lines: string[] = ["# Act Output", ""];

  if (data.toolCalls.length > 0) {
    lines.push("## Tool Calls", "");
    for (let i = 0; i < data.toolCalls.length; i++) {
      const call = data.toolCalls[i]!;
      lines.push(`### Call ${i + 1}: ${call.tool}`, "");
      lines.push("**Input:**", summarizeValue(call.input), "");
      if (call.outputStorage === "raw_file") {
        lines.push(`**Output Storage:** raw_file`, "");
        if (call.rawOutputPath) {
          lines.push(`**Raw Output File:** ${call.rawOutputPath}`, "");
        }
        if (typeof call.rawOutputChars === "number") {
          lines.push(`**Raw Output Chars:** ${call.rawOutputChars}`, "");
        }
        lines.push("**Output Preview:**", call.output, "");
      } else {
        lines.push("**Output:**", call.output, "");
      }
      if (call.outputTruncated) {
        lines.push("**Output Truncated:** yes", "");
      }
      if (call.error) {
        lines.push(`**Error:** ${call.error}`, "");
      }
    }
  } else {
    lines.push("## Tool Calls", "", "_No tool calls made._", "");
  }

  if (data.finalText) {
    lines.push("## Final Text", "", data.finalText, "");
  }

  if (data.stoppedEarlyReason) {
    lines.push("## Stop Reason", "", data.stoppedEarlyReason, "");
  }

  return lines.join("\n");
}

function summarizeError(error: string, maxLen = 180): string {
  const compact = error.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen)}...`;
}

export function formatVerifyMarkdown(data: VerifyOutput, toolCalls: ActToolCallRecord[] = []): string {
  const passCount = toolCalls.filter((call) => !call.error).length;
  const failCount = toolCalls.length - passCount;
  const lines: string[] = [
    "# Verify Output",
    "",
    `- **Passed:** ${data.passed ? "yes" : "no"}`,
    `- **Method:** ${data.method}`,
    `- **Execution Status:** ${data.executionStatus}`,
    `- **Validation Status:** ${data.validationStatus}`,
  ];

  if (toolCalls.length > 0) {
    lines.push("", "## Tool Calls", "");
    for (let i = 0; i < toolCalls.length; i++) {
      const call = toolCalls[i]!;
      if (call.error) {
        lines.push(`- ${i + 1}. ${call.tool} - fail (${summarizeError(call.error)})`);
      } else {
        lines.push(`- ${i + 1}. ${call.tool} - pass`);
      }
    }
  }

  lines.push("", `- **Tool Summary:** pass=${passCount}, fail=${failCount}`);

  if (data.summary.trim().length > 0) {
    lines.push("", "## Verified Summary", "", summarizeValue(data.summary, 400), "");
  }
  if (data.evidenceSummary.trim().length > 0) {
    lines.push("", "## Evidence Summary", "", summarizeValue(data.evidenceSummary, 400), "");
  }
  if (data.evidenceItems.length > 0) {
    lines.push("", "## Evidence Items", "");
    for (const evidence of data.evidenceItems) {
      lines.push(`- ${summarizeValue(evidence, 220)}`);
    }
  }
  if (data.usedRawArtifacts.length > 0) {
    lines.push("", "## Raw Artifacts Used", "");
    for (const artifactPath of data.usedRawArtifacts) {
      lines.push(`- ${artifactPath}`);
    }
  }

  if (data.taskProgress) {
    lines.push("", "## Task Progress", "");
    lines.push(`- Status: ${data.taskProgress.status}`);
    if (data.taskProgress.progressSummary.trim().length > 0) {
      lines.push(`- Progress Summary: ${summarizeValue(data.taskProgress.progressSummary, 220)}`);
    }
    if (data.taskProgress.currentFocus?.trim().length) {
      lines.push(`- Current Focus: ${summarizeValue(data.taskProgress.currentFocus, 220)}`);
    }
    if ((data.taskProgress.completedMilestones ?? []).length > 0) {
      lines.push(`- Completed Milestones: ${(data.taskProgress.completedMilestones ?? []).map((item) => summarizeValue(item, 180)).join(" | ")}`);
    }
    if ((data.taskProgress.openWork ?? []).length > 0) {
      lines.push(`- Open Work: ${(data.taskProgress.openWork ?? []).map((item) => summarizeValue(item, 180)).join(" | ")}`);
    }
    if ((data.taskProgress.blockers ?? []).length > 0) {
      lines.push(`- Blockers: ${(data.taskProgress.blockers ?? []).map((item) => summarizeValue(item, 180)).join(" | ")}`);
    }
    if (data.taskProgress.keyFacts.length > 0) {
      lines.push(`- Key Facts: ${data.taskProgress.keyFacts.map((fact) => summarizeValue(fact, 180)).join(" | ")}`);
    }
    if (data.taskProgress.evidence.length > 0) {
      lines.push(`- Evidence: ${data.taskProgress.evidence.map((evidence) => summarizeValue(evidence, 180)).join(" | ")}`);
    }
    if (data.taskProgress.userInputNeeded) {
      lines.push(`- User Input Needed: ${summarizeValue(data.taskProgress.userInputNeeded, 220)}`);
    }
  }

  return lines.join("\n");
}

function sanitizeStepSummary(step: LoopState["completedSteps"][number]): LoopState["completedSteps"][number] {
  const {
    stepRecord: _stepRecord,
    fullStepText: _fullStepText,
    ...persistedStep
  } = step as LoopState["completedSteps"][number] & { stepRecord?: unknown; fullStepText?: unknown };
  return persistedStep;
}
