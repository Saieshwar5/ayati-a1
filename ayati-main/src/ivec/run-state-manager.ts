import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ArtifactRef,
  AssertionResult,
  ToolOperationStatus,
  ToolResultV2,
  VerifiedFact,
} from "../skills/types.js";
import type {
  StepSummary,
  StepExpectationCheckStatus,
  TaskProgressState,
  VerificationExecutionStatus,
  VerificationMethod,
  StepVerificationPolicy,
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
  result?: ToolResultV2;
  operationStatus?: ToolOperationStatus;
  code?: string;
  artifacts?: ArtifactRef[];
  verifiedFacts?: VerifiedFact[];
  assertionResults?: AssertionResult[];
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
  contractVersion?: 2;
  verificationPolicy?: StepVerificationPolicy;
  verificationRationale?: string;
  expectedArtifacts?: string[];
  expectedStateChange?: string;
  requiresFullStepContext?: boolean;
  expectationCheckStatus?: StepExpectationCheckStatus;
  expectationCheckSummary?: string;
  verificationMethod?: VerificationMethod;
  executionStatus?: VerificationExecutionStatus;
  validationStatus?: VerificationValidationStatus;
  evidenceSummary?: string;
  evidenceItems: string[];
  taskProgress?: TaskProgressState;
  stoppedEarlyReason?: StepSummary["stoppedEarlyReason"];
  failureType?: StepSummary["failureType"];
  blockedTargets: string[];
  act: {
    toolCalls: StepRecordToolCall[];
    finalText: string;
  };
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

}
