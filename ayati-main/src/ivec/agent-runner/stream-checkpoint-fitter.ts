import {
  CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS,
  type ContextCheckpointPlan,
  type ContextCheckpointStatement,
  type ContextCheckpointSummary,
} from "ayati-context-engine";
import { estimateTextTokens } from "../../prompt/token-estimator.js";

export const STREAM_CHECKPOINT_MODEL_TARGET_RATIO = 2 / 3;

export const STREAM_CHECKPOINT_SUMMARY_KEYS = [
  "userRequests",
  "constraints",
  "decisions",
  "corrections",
  "importantFacts",
  "unresolvedQuestions",
  "references",
] as const;

export type StreamCheckpointSummaryKey = typeof STREAM_CHECKPOINT_SUMMARY_KEYS[number];

export interface StreamCheckpointFitResult {
  summary: ContextCheckpointSummary;
  tokenCount: number;
  droppedCounts: Record<StreamCheckpointSummaryKey, number>;
  truncatedCounts: Record<StreamCheckpointSummaryKey, number>;
}

const PRIORITY_KEYS: StreamCheckpointSummaryKey[] = [
  "userRequests",
  "constraints",
  "corrections",
  "unresolvedQuestions",
  "decisions",
  "importantFacts",
  "references",
];
const ESSENTIAL_KEYS = new Set<StreamCheckpointSummaryKey>([
  "userRequests",
  "constraints",
  "corrections",
  "unresolvedQuestions",
]);
const MAX_STATEMENT_CHARS = 320;
const MAX_NARRATIVE_CHARS = 600;
const FALLBACK_NARRATIVE = "Older conversation was compacted; exact history remains available.";

export function checkpointModelTargetTokens(maximumTokens: number): number {
  return Math.max(120, Math.floor(maximumTokens * STREAM_CHECKPOINT_MODEL_TARGET_RATIO));
}

export function checkpointSummaryTokenCount(summary: ContextCheckpointSummary): number {
  return estimateTextTokens(JSON.stringify(summary));
}

export function checkpointPlanAnchors(plan: ContextCheckpointPlan): Set<number> {
  return new Set([
    ...(plan.previousCheckpoint?.exactAnchors ?? []),
    ...plan.selectedMessages.map((message) => message.sequence),
  ]);
}

export function fitCheckpointToBudget(input: {
  summary: ContextCheckpointSummary;
  validAnchors: ReadonlySet<number>;
  maximumTokens: number;
}): StreamCheckpointFitResult {
  const maximumTokens = Math.max(1, Math.trunc(input.maximumTokens));
  const output = emptySummary();
  const droppedCounts = emptyCounts();
  const truncatedCounts = emptyCounts();
  if (checkpointSummaryTokenCount(output) > maximumTokens) {
    throw new Error(`checkpoint budget ${maximumTokens} cannot contain the minimum summary schema`);
  }

  const seen = new Set<string>();
  for (const key of PRIORITY_KEYS) {
    const statements = normalizeStatements(input.summary[key], input.validAnchors)
      .sort((left, right) => right.seq - left.seq || left.text.localeCompare(right.text));
    for (const statement of statements) {
      if (output[key].length >= CONTEXT_CHECKPOINT_CATEGORY_MAX_ITEMS) {
        droppedCounts[key] += 1;
        continue;
      }
      const identity = `${statement.seq}\u0000${statement.text}`;
      if (seen.has(identity)) {
        droppedCounts[key] += 1;
        continue;
      }
      seen.add(identity);
      const boundedText = boundedExcerpt(statement.text, MAX_STATEMENT_CHARS);
      const bounded = { seq: statement.seq, text: boundedText };
      if (boundedText !== statement.text) truncatedCounts[key] += 1;
      if (tryStatement(output, key, bounded, maximumTokens)) continue;

      if (ESSENTIAL_KEYS.has(key)) {
        const reference = {
          seq: statement.seq,
          text: `See exact message sequence ${statement.seq} for the complete ${statementLabel(key)}.`,
        };
        if (tryStatement(output, key, reference, maximumTokens)) {
          truncatedCounts[key] += boundedText === statement.text ? 1 : 0;
          continue;
        }
      }
      droppedCounts[key] += 1;
    }
  }

  output.narrative = fitNarrative({
    output,
    requested: normalizeText(input.summary.narrative),
    maximumTokens,
  });
  sortOutputChronologically(output);
  const tokenCount = checkpointSummaryTokenCount(output);
  if (tokenCount > maximumTokens) {
    throw new Error(`deterministic checkpoint fitter exceeded budget ${maximumTokens}`);
  }
  return { summary: output, tokenCount, droppedCounts, truncatedCounts };
}

export function createDeterministicCheckpointFallback(input: {
  plan: ContextCheckpointPlan;
  maximumTokens: number;
}): StreamCheckpointFitResult {
  const source = emptySummary(input.plan.previousCheckpoint?.summary.narrative);
  if (input.plan.previousCheckpoint) {
    for (const key of STREAM_CHECKPOINT_SUMMARY_KEYS) {
      source[key].push(...input.plan.previousCheckpoint.summary[key]);
    }
  }
  for (const message of input.plan.selectedMessages) {
    const statement = { seq: message.sequence, text: message.content };
    if (message.role === "user") {
      source.userRequests.push(statement);
    } else if (message.role === "system_event") {
      source.importantFacts.push({
        seq: message.sequence,
        text: `System event: ${message.content}`,
      });
    } else if (message.responseKind === "feedback") {
      source.unresolvedQuestions.push(statement);
    } else {
      source.importantFacts.push({
        seq: message.sequence,
        text: `Assistant response: ${message.content}`,
      });
    }
    for (const attachment of message.attachmentRefs ?? []) {
      source.references.push({
        seq: message.sequence,
        text: `Attachment ${attachment.displayName} (${attachment.kind}, ${attachment.resourceId}).`,
      });
    }
  }
  return fitCheckpointToBudget({
    summary: source,
    validAnchors: checkpointPlanAnchors(input.plan),
    maximumTokens: input.maximumTokens,
  });
}

function emptySummary(narrative = FALLBACK_NARRATIVE): ContextCheckpointSummary {
  return {
    userRequests: [],
    constraints: [],
    decisions: [],
    corrections: [],
    importantFacts: [],
    unresolvedQuestions: [],
    references: [],
    narrative: normalizeText(narrative) || FALLBACK_NARRATIVE,
  };
}

function emptyCounts(): Record<StreamCheckpointSummaryKey, number> {
  return {
    userRequests: 0,
    constraints: 0,
    decisions: 0,
    corrections: 0,
    importantFacts: 0,
    unresolvedQuestions: 0,
    references: 0,
  };
}

function normalizeStatements(
  statements: ContextCheckpointStatement[],
  validAnchors: ReadonlySet<number>,
): ContextCheckpointStatement[] {
  return statements.flatMap((statement) => {
    const text = normalizeText(statement.text);
    return validAnchors.has(statement.seq) && text
      ? [{ seq: statement.seq, text }]
      : [];
  });
}

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function boundedExcerpt(value: string, maximumChars: number): string {
  if (value.length <= maximumChars) return value;
  const characters = [...value];
  const separator = " … ";
  const available = Math.max(1, maximumChars - separator.length);
  const headBudget = Math.ceil(available * 0.7);
  const tailBudget = Math.max(0, available - headBudget);
  return `${takePrefix(characters, headBudget)}${separator}${takeSuffix(characters, tailBudget)}`;
}

function takePrefix(characters: string[], maximumChars: number): string {
  let output = "";
  for (const character of characters) {
    if (output.length + character.length > maximumChars) break;
    output += character;
  }
  return output;
}

function takeSuffix(characters: string[], maximumChars: number): string {
  let output = "";
  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index]!;
    if (output.length + character.length > maximumChars) break;
    output = character + output;
  }
  return output;
}

function tryStatement(
  output: ContextCheckpointSummary,
  key: StreamCheckpointSummaryKey,
  statement: ContextCheckpointStatement,
  maximumTokens: number,
): boolean {
  output[key].push(statement);
  if (checkpointSummaryTokenCount(output) <= maximumTokens) return true;
  output[key].pop();
  return false;
}

function fitNarrative(input: {
  output: ContextCheckpointSummary;
  requested: string;
  maximumTokens: number;
}): string {
  const requested = boundedExcerpt(input.requested || FALLBACK_NARRATIVE, MAX_NARRATIVE_CHARS);
  if (narrativeFits(input.output, requested, input.maximumTokens)) return requested;
  const characters = [...requested];
  let low = 1;
  let high = characters.length;
  let best = input.output.narrative;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = middle < characters.length
      ? `${characters.slice(0, Math.max(1, middle - 1)).join("")}…`
      : requested;
    if (narrativeFits(input.output, candidate, input.maximumTokens)) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function narrativeFits(
  output: ContextCheckpointSummary,
  narrative: string,
  maximumTokens: number,
): boolean {
  const previous = output.narrative;
  output.narrative = narrative;
  const fits = checkpointSummaryTokenCount(output) <= maximumTokens;
  output.narrative = previous;
  return fits;
}

function sortOutputChronologically(summary: ContextCheckpointSummary): void {
  for (const key of STREAM_CHECKPOINT_SUMMARY_KEYS) {
    summary[key].sort((left, right) => left.seq - right.seq || left.text.localeCompare(right.text));
  }
}

function statementLabel(key: StreamCheckpointSummaryKey): string {
  switch (key) {
    case "userRequests": return "user request";
    case "constraints": return "constraint";
    case "corrections": return "correction";
    case "unresolvedQuestions": return "unresolved question";
    case "decisions": return "decision";
    case "importantFacts": return "important fact";
    case "references": return "reference";
  }
}
