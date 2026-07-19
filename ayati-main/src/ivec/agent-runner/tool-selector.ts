import type { ToolDefinition } from "../../skills/types.js";
import type { LoopState } from "../types.js";
import {
  deriveWorkstreamBindingCapabilityPolicy,
  filterToolsByWorkstreamBinding,
  requiredRoutingControls,
} from "./workstream-binding-capability-policy.js";

export const PRESSURE_MAX_SELECTED_TOOLS = 10;

export function selectToolsForDecision(
  state: LoopState,
  toolDefinitions: ToolDefinition[],
  limit: number,
): ToolDefinition[] {
  const policy = deriveWorkstreamBindingCapabilityPolicy(state);
  const candidateTools = filterToolsByWorkstreamBinding(policy, toolDefinitions);
  const requiredToolNames = new Set(requiredRoutingControls(policy, state));
  const requiredTools = candidateTools.filter((tool) => requiredToolNames.has(tool.name));
  const budgetedTools = candidateTools.filter((tool) => !requiredToolNames.has(tool.name));
  const selectedToolLimit = resolveSelectedToolLimit(state, limit);
  const requiredWithinLimit = requiredTools.slice(0, selectedToolLimit);
  const budgetedToolLimit = Math.max(0, selectedToolLimit - requiredWithinLimit.length);

  return appendUniqueTools(
    selectBudgetedTools(state, budgetedTools, budgetedToolLimit),
    requiredWithinLimit,
  );
}

export function resolveSelectedToolLimit(state: LoopState, configuredLimit: number): number {
  const normalizedLimit = Math.max(0, Math.floor(configuredLimit));
  return isContextPressureActive(state)
    ? Math.min(normalizedLimit, PRESSURE_MAX_SELECTED_TOOLS)
    : normalizedLimit;
}

export function isContextPressureActive(state: LoopState): boolean {
  return Boolean(state.contextPressure && state.contextPressure.mode !== "full");
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
  const workstream = state.harnessContext.contextEngine?.workstream;
  const focus = state.harnessContext.contextEngine?.focus;
  if (!workstream && !focus) return [];
  return [
    focus && "ref" in focus ? focus.ref : undefined,
    focus && "reason" in focus ? focus.reason : undefined,
    workstream?.workstreamId,
    workstream?.title,
    workstream?.objective,
    workstream?.summary,
    workstream?.workstreamStatus,
    workstream?.currentFocus,
    workstream?.next,
    workstream?.currentRequest?.title,
    workstream?.currentRequest?.request,
    ...(workstream?.blockers ?? []),
    ...(workstream?.resources ?? []).flatMap(({ resource }) => [
      resource.resourceId,
      resource.displayName,
      resource.description,
      ...resource.aliases,
      resource.locator.kind === "filesystem" ? resource.locator.path : undefined,
      resource.locator.kind === "url" ? resource.locator.url : undefined,
      resource.kind,
    ]),
  ].filter((term): term is string => typeof term === "string" && term.trim().length > 0);
}

function gitContextAttachmentTerms(state: LoopState): string[] {
  const resourceTerms = (state.harnessContext.contextEngine?.workstream?.resources ?? []).flatMap(({ resource }) => [
    resource.displayName,
    ...resource.aliases,
    resource.locator.kind === "filesystem" ? resource.locator.path : undefined,
    resource.kind,
  ]);
  if (resourceTerms.length === 0) {
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
    ...resourceTerms,
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
  if (domain === "process" && intersects(tokens, ["run", "command", "build", "test", "install", "server", "process"])) {
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
