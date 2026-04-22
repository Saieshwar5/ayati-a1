import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  StepSummary,
  VerificationExecutionStatus,
  VerificationMethod,
  VerificationValidationStatus,
} from "./types.js";
import { devWarn } from "../shared/index.js";

const STEP_RECORDS_FILENAME = "step-records.jsonl";

export interface StepRecordToolCall {
  tool: string;
  input: unknown;
  output: string;
  outputStorage?: "inline" | "raw_file";
  rawOutputPath?: string;
  rawOutputChars?: number;
  outputTruncated?: boolean;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface StepRecord {
  step: number;
  executionContract: string;
  outcome: string;
  summary: string;
  newFacts: string[];
  artifacts: string[];
  toolSuccessCount: number;
  toolFailureCount: number;
  verificationMethod?: VerificationMethod;
  executionStatus?: VerificationExecutionStatus;
  validationStatus?: VerificationValidationStatus;
  evidenceSummary?: string;
  evidenceItems: string[];
  stoppedEarlyReason?: StepSummary["stoppedEarlyReason"];
  failureType?: StepSummary["failureType"];
  blockedTargets: string[];
  act: {
    toolCalls: StepRecordToolCall[];
    finalText: string;
  };
}

export interface ControllerStepDigest {
  step: number;
  executionContract: string;
  outcome: string;
  summary: string;
  keyFacts: string[];
  evidence: string[];
  artifacts: string[];
  blockedTargets: string[];
  stoppedEarlyReason?: StepSummary["stoppedEarlyReason"];
  toolSuccessCount: number;
  toolFailureCount: number;
}

export interface ControllerHistoryBundle {
  currentStepCount: number;
  latestCompletedStepFullText?: string;
  recentStepDigests: ControllerStepDigest[];
}

export interface SummaryWindowResult {
  window: { from: number; to: number };
  steps: ControllerStepDigest[];
}

export interface StepFullResult {
  step: number;
  record: StepRecord;
  fullStepText: string;
}

export class RunStateManager {
  private readonly runPath: string;
  private readonly stepRecordsPath: string;
  private readonly stepRecords = new Map<number, StepRecord>();
  private readonly fullStepTextCache = new Map<number, string>();
  private readyPromise: Promise<void>;

  constructor(runPath: string) {
    this.runPath = runPath;
    this.stepRecordsPath = join(runPath, STEP_RECORDS_FILENAME);
    this.readyPromise = this.loadFromDisk();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  async appendStepRecord(record: StepRecord, fullStepText: string): Promise<void> {
    await this.ready();
    this.stepRecords.set(record.step, record);
    this.fullStepTextCache.set(record.step, fullStepText);
    await appendFile(this.stepRecordsPath, `${JSON.stringify(record)}\n`, "utf-8");
  }

  async buildControllerHistoryBundle(completedSteps: StepSummary[]): Promise<ControllerHistoryBundle> {
    await this.ready();
    const latestStep = completedSteps[completedSteps.length - 1];
    const latestCompletedStepFullText = latestStep
      ? await this.readFullStepText(latestStep.step)
      : undefined;
    const recentSteps = completedSteps.slice(-5, -1).reverse().slice(0, 4);

    return {
      currentStepCount: completedSteps.length,
      latestCompletedStepFullText,
      recentStepDigests: recentSteps.map((step) => this.toControllerStepDigest(step)),
    };
  }

  async readSummaryWindow(window: { from: number; to: number }): Promise<SummaryWindowResult> {
    await this.ready();
    const from = Math.min(window.from, window.to);
    const to = Math.max(window.from, window.to);
    const steps: ControllerStepDigest[] = [];
    for (let stepNumber = from; stepNumber <= to; stepNumber++) {
      const record = this.stepRecords.get(stepNumber);
      if (!record) {
        continue;
      }
      steps.push(this.toControllerStepDigest(record));
    }
    return { window: { from, to }, steps };
  }

  async readStepFull(step: number): Promise<StepFullResult | null> {
    await this.ready();
    const record = this.stepRecords.get(step);
    if (!record) {
      return null;
    }
    return {
      step,
      record,
      fullStepText: await this.readFullStepText(step),
    };
  }

  private async loadFromDisk(): Promise<void> {
    if (!existsSync(this.stepRecordsPath)) {
      return;
    }
    try {
      const raw = await readFile(this.stepRecordsPath, "utf-8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        const parsed = JSON.parse(trimmed) as StepRecord;
        if (typeof parsed.step === "number") {
          this.stepRecords.set(parsed.step, parsed);
        }
      }
    } catch (error) {
      devWarn(
        `[run-state] failed to load persisted step records: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async readFullStepText(step: number): Promise<string> {
    const cached = this.fullStepTextCache.get(step);
    if (cached) {
      return cached;
    }
    const pad = String(step).padStart(3, "0");
    const actPath = join(this.runPath, "steps", `${pad}-act.md`);
    const verifyPath = join(this.runPath, "steps", `${pad}-verify.md`);
    const [actText, verifyText] = await Promise.all([
      readOptionalText(actPath),
      readOptionalText(verifyPath),
    ]);
    const fullText = [
      `Step ${step}`,
      actText.trim().length > 0 ? actText.trim() : "Act output unavailable.",
      verifyText.trim().length > 0 ? verifyText.trim() : "Verify output unavailable.",
    ].join("\n\n");
    this.fullStepTextCache.set(step, fullText);
    return fullText;
  }

  private toControllerStepDigest(step: StepSummary | StepRecord): ControllerStepDigest {
    const executionContract = step.executionContract ?? "";
    const newFacts = Array.isArray(step.newFacts) ? step.newFacts : [];
    const evidenceItems = Array.isArray(step.evidenceItems) ? step.evidenceItems : [];
    const blockedTargets = Array.isArray(step.blockedTargets) ? step.blockedTargets : [];
    return {
      step: step.step,
      executionContract,
      outcome: step.outcome,
      summary: step.summary,
      keyFacts: newFacts.slice(0, 6),
      evidence: evidenceItems.slice(0, 6),
      artifacts: step.artifacts.slice(0, 6),
      blockedTargets: blockedTargets.slice(0, 4),
      stoppedEarlyReason: step.stoppedEarlyReason,
      toolSuccessCount: step.toolSuccessCount,
      toolFailureCount: step.toolFailureCount,
    };
  }
}

async function readOptionalText(path: string): Promise<string> {
  if (!existsSync(path)) {
    return "";
  }
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}
