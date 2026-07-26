import type { RunToolCallContext } from "../types.js";
import {
  buildCurrentRunVerificationIndex,
  type RunVerifiedOutcome,
} from "./run-verification-index.js";
import type {
  FileReadValidationScope,
  FileSearchValidationScope,
  TaskValidationOutcomeKind,
} from "./task-validation-contracts.js";

export interface PromptVerifiedOutcomeSource {
  step: number;
  callId?: string;
  tool: string;
}

export interface PromptVerifiedOutcome {
  kind: TaskValidationOutcomeKind;
  subject: string;
  actualKind?: "file" | "directory";
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

  if (outcome.family === "filesystem_path") {
    return {
      kind: outcome.kind,
      subject: outcome.subject,
      ...(outcome.actualKind ? { actualKind: outcome.actualKind } : {}),
      source,
    };
  }

  if (outcome.family === "filesystem_read") {
    if (outcome.kind === "file.read_complete") {
      return {
        kind: "file.read_complete",
        subject: outcome.subject,
        actualKind: "file",
        source,
      };
    }
    if (outcome.readScope) {
      return {
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
    return {
      kind: "file.search_no_match",
      subject: outcome.subject,
      searchScope: outcome.searchScope,
      source,
    };
  }

  if (outcome.family === "tool_denial") {
    return {
      kind: "tool.call_denied",
      subject: outcome.subject,
      denialCode: outcome.denialCode,
      ...(outcome.target ? { target: outcome.target } : {}),
      source,
    };
  }

  if (outcome.family === "task") {
    return {
      kind: outcome.kind,
      subject: outcome.subject,
      ...(outcome.artifactKind ? { artifactKind: outcome.artifactKind } : {}),
      source,
    };
  }

  return undefined;
}
