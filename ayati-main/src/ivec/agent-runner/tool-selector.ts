import type { ToolDefinition } from "../../skills/types.js";
import type { MemoryRunHandle } from "../../memory/types.js";
import type { LoopState } from "../types.js";
import {
  detectRuntimeCapabilityMode,
  filterToolsForRuntimeMode,
  requiredRoutingMutationToolsForRuntimeMode,
} from "./runtime-capability-mode.js";
import {
  hasRecoverableCompactedRunToolCall,
  RUN_STEP_RECOVERY_TOOL_NAME,
} from "./run-tool-call-context.js";

export function selectToolsForDecision(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  limit: number,
  input: {
    workRunHandle?: MemoryRunHandle;
    sessionRunHandle?: MemoryRunHandle;
  } = {},
): ToolDefinition[] {
  const mode = detectRuntimeCapabilityMode({
    state,
    workRunHandle: input.workRunHandle,
    sessionRunHandle: input.sessionRunHandle,
  });
  const candidateTools = filterToolsForRuntimeMode(mode, toolDefinitions);
  const requiredToolNames = new Set(requiredRoutingMutationToolsForRuntimeMode(mode));
  if (hasRecoverableCompactedRunToolCall(state.toolContext?.toolCalls)) {
    requiredToolNames.add(RUN_STEP_RECOVERY_TOOL_NAME);
  }
  const requiredTools = candidateTools.filter((tool) => requiredToolNames.has(tool.name));
  const budgetedTools = candidateTools.filter((tool) => !requiredToolNames.has(tool.name));

  return appendUniqueTools(selectBudgetedTools(state, budgetedTools, limit), requiredTools);
}

function selectBudgetedTools(
  state: LoopState,
  candidateTools: ToolDefinition[],
  limit: number,
): ToolDefinition[] {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (candidateTools.length <= normalizedLimit) {
    return [...candidateTools];
  }

  if (normalizedLimit === 0) {
    return [];
  }

  const query = buildToolSelectionQuery(state);
  const tokens = tokenize(query);
  const scored = candidateTools.map((tool, index) => ({
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

function appendUniqueTools(primary: ToolDefinition[], additional: ToolDefinition[]): ToolDefinition[] {
  const seen = new Set<string>();
  const merged: ToolDefinition[] = [];
  for (const tool of [...primary, ...additional]) {
    if (seen.has(tool.name)) {
      continue;
    }
    seen.add(tool.name);
    merged.push(tool);
  }
  return merged;
}

function buildToolSelectionQuery(state: LoopState): string {
  const parts = [
    state.userMessage,
    state.workState.summary,
    state.workState.nextStep,
    ...(state.workState.openWork ?? []),
    ...(state.workState.blockers ?? []),
    ...(state.workState.taskNotes ?? []).flatMap((note) => [
      note.text,
      note.source,
    ]),
    ...(state.toolContext?.recent ?? []).flatMap((card) => [
      card.tool,
      card.purpose,
      card.content,
      card.evidenceRef,
      card.sourceEvidenceRef,
    ]),
    ...gitContextTerms(state),
    ...gitContextAttachmentTerms(state),
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

function gitContextTerms(state: LoopState): string[] {
  const task = state.harnessContext.contextEngine?.task;
  const focus = state.harnessContext.contextEngine?.focus;
  if (!task && !focus) return [];
  return [
    focus && "ref" in focus ? focus.ref : undefined,
    focus && "reason" in focus ? focus.reason : undefined,
    task?.workId,
    task?.title,
    task?.objective,
    task?.status,
    task?.next,
    ...(task?.completed ?? []),
    ...(task?.open ?? []),
    ...(task?.blockers ?? []),
    ...(task?.facts ?? []).map((fact) => fact.text),
    ...(task?.assets ?? []).flatMap((asset) => [
      asset.name,
      asset.path,
      asset.kind,
    ]),
    ...(task?.recentRuns ?? []).flatMap((run) => [
      run.summary,
      run.status,
      ...run.completed,
      ...run.open,
    ]),
  ].filter((term): term is string => typeof term === "string" && term.trim().length > 0);
}

function gitContextAttachmentTerms(state: LoopState): string[] {
  const artifactTerms = (state.harnessContext.contextEngine?.task?.assets ?? []).flatMap((asset) => [
    asset.name,
    asset.path,
    asset.kind,
  ]);
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
