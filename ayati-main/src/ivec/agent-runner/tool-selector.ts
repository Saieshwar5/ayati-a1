import type { ToolDefinition } from "../../skills/types.js";
import type { LoopState } from "../types.js";

export function selectToolsForDecision(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  limit: number,
): ToolDefinition[] {
  if (toolDefinitions.length <= limit) {
    return [...toolDefinitions];
  }

  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) {
    return [];
  }

  const query = buildToolSelectionQuery(state);
  const tokens = tokenize(query);
  const scored = toolDefinitions.map((tool, index) => ({
    tool,
    index,
    score: scoreTool(tool, tokens, query),
  }));
  const matches = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  if (matches.length > 0) {
    return matches
      .slice(0, normalizedLimit)
      .map((entry) => entry.tool);
  }

  return scored
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, normalizedLimit)
    .map((entry) => entry.tool);
}

function buildToolSelectionQuery(state: LoopState): string {
  const parts = [
    state.userMessage,
    state.workState.summary,
    state.workState.nextStep,
    ...(state.workState.openWork ?? []),
    ...(state.workState.blockers ?? []),
    ...(state.toolContext?.recent ?? []).flatMap((card) => [
      card.tool,
      card.purpose,
      card.content,
      card.evidenceRef,
      card.sourceEvidenceRef,
    ]),
    ...(state.latestObservations ?? []).flatMap((observation) => [
      observation.tool,
      observation.purpose,
      observation.content,
      observation.evidenceRef,
      observation.sourceEvidenceRef,
    ]),
    state.latestObservation?.content,
    state.latestObservation?.evidenceRef,
    ...(state.workState.evidenceRefs ?? []).flatMap((ref) => [
      ref.id,
      ref.ref,
      ref.title,
      ref.tool,
      ...ref.access,
    ]),
    ...continuityTerms(state),
    ...activityContinuationAttachmentTerms(state),
    ...(state.completedSteps.slice(-2).flatMap((step) => [
      step.executionContract,
      step.summary,
      ...(step.blockedTargets ?? []),
    ])),
    ...(state.failureHistory.slice(-2).flatMap((failure) => [
      failure.reason,
      ...(failure.blockedTargets ?? []),
    ])),
  ];
  return parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" ");
}

function continuityTerms(state: LoopState): string[] {
  const continuity = state.continuity;
  if (!continuity) return [];
  return [
    continuity.mode,
    ...(continuity.reasons ?? []),
    continuity.current?.title,
    continuity.current?.goal,
    continuity.current?.nextStep,
    ...(continuity.current?.openWork ?? []),
    ...(continuity.current?.verifiedFacts ?? []),
    ...(continuity.current?.topAssets ?? []),
    ...(continuity.candidates ?? []).flatMap((candidate) => [
      candidate.title,
      candidate.reason,
      ...candidate.topAssets,
    ]),
  ].filter((term): term is string => typeof term === "string" && term.trim().length > 0);
}

function activityContinuationAttachmentTerms(state: LoopState): string[] {
  const artifactTerms = [
    ...(state.continuity?.current?.topAssets ?? []),
    ...(state.continuity?.candidates ?? []).flatMap((candidate) => candidate.topAssets),
  ];
  if (artifactTerms.length === 0) {
    return [];
  }
  return [
    "attachment",
    "attachment_restore",
    "restore",
    "query",
    "read",
    "document_query",
    "attachment_query",
    "directory_search",
    "file",
    "directory",
    "document",
    "dataset",
    ...artifactTerms,
  ].filter((term): term is string => typeof term === "string" && term.trim().length > 0);
}

function scoreTool(tool: ToolDefinition, tokens: Set<string>, query: string): number {
  let score = 0;
  const haystack = [
    tool.name,
    tool.description,
    tool.annotations?.domain,
    tool.selectionHints?.domain,
    ...(tool.selectionHints?.tags ?? []),
    ...(tool.selectionHints?.aliases ?? []),
    ...(tool.selectionHints?.examples ?? []),
  ].join(" ").toLowerCase();

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += token.length > 4 ? 3 : 1;
    }
  }

  if (query.toLowerCase().includes(tool.name.toLowerCase())) {
    score += 10;
  }

  if (tool.selectionHints?.priority) {
    score += tool.selectionHints.priority;
  }

  score += scoreDomainNeed(tool, tokens);
  return score;
}

function scoreDomainNeed(tool: ToolDefinition, tokens: Set<string>): number {
  const domain = tool.annotations?.domain ?? tool.selectionHints?.domain;
  if (domain === "filesystem" && intersects(tokens, ["file", "files", "folder", "directory", "write", "edit", "read", "create", "delete", "move", "save"])) {
    return 8;
  }
  if (domain === "shell" && intersects(tokens, ["run", "command", "terminal", "build", "test", "install", "server"])) {
    return 6;
  }
  if (domain === "documents" && intersects(tokens, ["document", "pdf", "doc", "extract", "summarize"])) {
    return 6;
  }
  if (domain === "attachments" && intersects(tokens, ["attachment", "attached", "restore", "file", "directory", "document", "dataset", "query", "read"])) {
    return 8;
  }
  if (domain === "files" && intersects(tokens, ["attachment", "attached", "file", "directory", "document", "dataset", "query", "read"])) {
    return 7;
  }
  if (domain === "database" && intersects(tokens, ["database", "sql", "table", "rows", "query"])) {
    return 6;
  }
  if (domain === "calculator" && intersects(tokens, ["calculate", "math", "sum", "average", "sqrt"])) {
    return 6;
  }
  if (domain === "pulse" && intersects(tokens, ["remind", "reminder", "schedule", "every", "tomorrow"])) {
    return 6;
  }
  return 0;
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length > 1),
  );
}

function intersects(tokens: Set<string>, values: string[]): boolean {
  return values.some((value) => tokens.has(value));
}
