import type { RunToolCallContext } from "../types.js";
import {
  buildCurrentRunVerificationIndex,
  type RunVerifiedOutcome,
} from "./run-verification-index.js";
import type {
  FileReadValidationScope,
  FileSearchCountValidation,
  FileSearchMatchValidation,
  FileSearchValidationScope,
  TaskValidationOutcomeKind,
} from "./task-validation-contracts.js";

export interface PromptVerifiedOutcomeSource {
  step: number;
  callId?: string;
  tool: string;
}

export interface PromptVerifiedOutcome {
  outcomeRef: string;
  kind: TaskValidationOutcomeKind;
  subject: string;
  actualKind?: "file" | "directory" | "symlink";
  modeOctal?: string;
  modeSymbolic?: string;
  searchMatch?: FileSearchMatchValidation;
  searchCount?: FileSearchCountValidation;
  searchScope?: FileSearchValidationScope;
  readScope?: FileReadValidationScope;
  artifactKind?: string;
  denialCode?: string;
  target?: string;
  source: PromptVerifiedOutcomeSource;
}

export type PromptVerifiedOutcomes = PromptVerifiedOutcome[];

/**
 * Projects only current completion proofs that the model can select during
 * task validation. Full verification records remain on the durable run calls.
 */
export function buildPromptVerifiedOutcomes(input: {
  runId: string;
  calls?: RunToolCallContext[];
}): PromptVerifiedOutcomes | undefined {
  const index = buildCurrentRunVerificationIndex(input);
  const outcomes = index.outcomes
    .filter((outcome) => outcome.role === "completion")
    .map(projectVerifiedOutcome)
    .filter((outcome): outcome is PromptVerifiedOutcome => outcome !== undefined);
  return outcomes.length > 0 ? outcomes : undefined;
}

function projectVerifiedOutcome(
  outcome: RunVerifiedOutcome,
): PromptVerifiedOutcome | undefined {
  if (!outcome.subject) return undefined;

  const source: PromptVerifiedOutcomeSource = {
    step: outcome.source.step,
    ...(outcome.source.callId ? { callId: outcome.source.callId } : {}),
    tool: outcome.source.tool,
  };
  const reference = { outcomeRef: outcome.id };

  if (outcome.family === "filesystem_path") {
    return {
      ...reference,
      kind: outcome.kind,
      subject: outcome.subject,
      ...(outcome.actualKind ? { actualKind: outcome.actualKind } : {}),
      ...(outcome.modeOctal ? { modeOctal: outcome.modeOctal } : {}),
      ...(outcome.modeSymbolic ? { modeSymbolic: outcome.modeSymbolic } : {}),
      source,
    };
  }

  if (outcome.family === "filesystem_read") {
    if (outcome.kind === "file.read_complete") {
      return {
        ...reference,
        kind: "file.read_complete",
        subject: outcome.subject,
        actualKind: "file",
        source,
      };
    }
    if (outcome.readScope) {
      return {
        ...reference,
        kind: "file.read_scope_satisfied",
        subject: outcome.subject,
        actualKind: "file",
        readScope: outcome.readScope,
        source,
      };
    }
    return undefined;
  }

  if (outcome.family === "filesystem_search") {
    if (outcome.kind === "file.search_count") {
      return {
        ...reference,
        kind: "file.search_count",
        subject: outcome.subject,
        searchCount: outcome.searchCount,
        source,
      };
    }
    if (outcome.kind === "file.search_match") {
      return {
        ...reference,
        kind: "file.search_match",
        subject: outcome.subject,
        actualKind: "file",
        searchMatch: outcome.searchMatch,
        source,
      };
    }
    return {
      ...reference,
      kind: "file.search_no_match",
      subject: outcome.subject,
      searchScope: outcome.searchScope,
      source,
    };
  }

  if (outcome.family === "tool_denial") {
    return {
      ...reference,
      kind: "tool.call_denied",
      subject: outcome.subject,
      denialCode: outcome.denialCode,
      ...(outcome.target ? { target: outcome.target } : {}),
      source,
    };
  }

  if (outcome.family === "task") {
    return {
      ...reference,
      kind: outcome.kind,
      subject: outcome.subject,
      ...(outcome.artifactKind ? { artifactKind: outcome.artifactKind } : {}),
      source,
    };
  }

  return undefined;
}
