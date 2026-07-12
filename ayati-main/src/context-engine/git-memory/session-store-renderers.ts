import type {
  GitMemoryConversationSeqRange,
  GitMemoryRunFile,
  GitMemoryRunStatus,
  GitMemorySessionRunFile,
  GitMemorySessionRunStatus,
  GitMemorySessionStepRecord,
  GitMemoryStepRecord,
} from "./schema.js";

export function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function jsonl<T>(records: T[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
}

export function renderTaskRunMarkdown(
  run: GitMemoryRunFile,
  steps: GitMemoryStepRecord[],
): string {
  return [
    `# Run ${run.runId}`,
    "",
    `Task: ${run.taskId}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    ...(run.completedAt ? [`Completed: ${run.completedAt}`] : []),
    ...(run.sessionStoreCommit ? [`Session Store Commit: ${run.sessionStoreCommit}`] : []),
    "",
    renderMarkdownParagraph("Intent", run.intent ?? run.summary),
    renderMarkdownParagraph("Routing", run.routing ?? formatConversationRefs(run.conversationRefs)),
    renderMarkdownParagraph("Outcome", run.outcome ?? defaultRunOutcome(run.status, run.summary)),
    renderMarkdownList("Work Performed", run.workPerformed ?? []),
    renderMarkdownList("Changed Files", run.changedFiles),
    renderMarkdownList("Verification", run.verification ?? []),
    renderStepEvidenceMarkdown(steps),
    renderMarkdownList("Decisions", run.decisions ?? []),
    renderMarkdownList("Blockers", run.blockers ?? []),
    renderMarkdownParagraph("Next", run.next ?? "No next step."),
    renderMarkdownList("New Facts", run.newFacts),
    renderStepActionMarkdown(steps),
  ].join("\n");
}

export function renderSessionRunMarkdown(
  run: GitMemorySessionRunFile,
  steps: GitMemorySessionStepRecord[],
): string {
  return [
    `# Session Run ${run.runId}`,
    "",
    `Session: ${run.sessionId}`,
    `Status: ${run.status}`,
    `Started: ${run.startedAt}`,
    ...(run.completedAt ? [`Completed: ${run.completedAt}`] : []),
    "",
    renderMarkdownParagraph("Intent", run.intent ?? run.summary),
    renderMarkdownParagraph("Routing", run.routing ?? formatConversationRefs(run.conversationRefs)),
    renderMarkdownParagraph("Outcome", run.outcome ?? defaultSessionRunOutcome(run.status, run.summary)),
    renderMarkdownList("Work Performed", run.workPerformed ?? []),
    renderMarkdownList("Changed Files", run.changedFiles),
    renderMarkdownList("Verification", run.verification ?? []),
    renderSessionStepEvidenceMarkdown(steps),
    renderMarkdownList("Decisions", run.decisions ?? []),
    renderMarkdownList("Tools Used", run.toolsUsed),
    renderMarkdownList("Blockers", run.blockers ?? []),
    renderMarkdownParagraph("Next", run.next ?? "No next step."),
    renderMarkdownList("New Facts", run.newFacts),
    renderSessionStepActionMarkdown(steps),
    ...(run.assistantResponse ? ["", "## Assistant Response", "", run.assistantResponse.trim(), ""] : []),
  ].join("\n");
}

export function defaultRunOutcome(status: GitMemoryRunStatus, summary: string): string {
  if (status === "incomplete") return `Run incomplete: ${summary}`;
  const normalizedSummary = summary.trim();
  if (status === "completed") {
    return normalizedSummary || "Run completed.";
  }
  if (status === "failed") {
    return normalizedSummary ? `Run failed: ${normalizedSummary}` : "Run failed.";
  }
  if (status === "blocked") {
    return normalizedSummary ? `Run blocked: ${normalizedSummary}` : "Run blocked.";
  }
  return normalizedSummary ? `Needs user input: ${normalizedSummary}` : "Needs user input.";
}

export function defaultSessionRunOutcome(status: GitMemorySessionRunStatus, summary: string): string {
  const normalizedSummary = summary.trim();
  if (status === "running") {
    return normalizedSummary || "Session run is active.";
  }
  if (status === "promoted") {
    return normalizedSummary || "Session run promoted.";
  }
  if (status === "completed") {
    return normalizedSummary || "Session run completed.";
  }
  if (status === "failed") {
    return normalizedSummary ? `Run failed: ${normalizedSummary}` : "Run failed.";
  }
  if (status === "blocked") {
    return normalizedSummary ? `Run blocked: ${normalizedSummary}` : "Run blocked.";
  }
  return normalizedSummary ? `Needs user input: ${normalizedSummary}` : "Needs user input.";
}

export function formatConversationRefs(refs: GitMemoryConversationSeqRange[]): string {
  if (refs.length === 0) {
    return "No conversation range recorded.";
  }
  return refs.map((ref) => `conversation ${ref.fromSeq}-${ref.toSeq}`).join(", ");
}

function renderSessionStepEvidenceMarkdown(steps: GitMemorySessionStepRecord[]): string {
  if (steps.length === 0) {
    return "## Evidence\n\nNone.\n";
  }
  return [
    "## Evidence",
    "",
    ...steps.map((record) => [
      `- Step ${record.step}: ${record.verification.evidenceSummary ?? record.verification.summary}`,
      ...(record.artifacts.length > 0 ? [`  Artifacts: ${record.artifacts.join(", ")}`] : []),
      ...(record.facts.length > 0 ? [`  Facts: ${record.facts.join("; ")}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderSessionStepActionMarkdown(steps: GitMemorySessionStepRecord[]): string {
  if (steps.length === 0) {
    return "## Actions\n\nNone.\n";
  }
  return [
    "## Actions",
    "",
    ...steps.map((step) => [
      `- Step ${step.step} ${step.status}: ${step.summary}`,
      ...(step.action?.["executionContract"] ? [`  Contract: ${String(step.action["executionContract"])}`] : []),
      ...(step.toolCalls.length > 0 ? [`  Tools: ${unique(step.toolCalls.map((call) => call.tool)).join(", ")}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderStepActionMarkdown(steps: GitMemoryStepRecord[]): string {
  if (steps.length === 0) {
    return "## Actions\n\nNone.\n";
  }
  return [
    "## Actions",
    "",
    ...steps.map((step) => [
      `- Step ${step.step} ${step.status}: ${step.summary}`,
      ...(step.action?.["executionContract"] ? [`  Contract: ${String(step.action["executionContract"])}`] : []),
      ...(step.toolCalls.length > 0 ? [`  Tools: ${unique(step.toolCalls.map((call) => call.tool)).join(", ")}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderStepEvidenceMarkdown(steps: GitMemoryStepRecord[]): string {
  if (steps.length === 0) {
    return "## Evidence\n\nNone.\n";
  }
  return [
    "## Evidence",
    "",
    ...steps.map((record) => [
      `- Step ${record.step}: ${record.verification.evidenceSummary ?? record.verification.summary}`,
      ...(record.artifacts.length > 0 ? [`  Artifacts: ${record.artifacts.join(", ")}`] : []),
      ...(record.facts.length > 0 ? [`  Facts: ${record.facts.join("; ")}`] : []),
    ].join("\n")),
    "",
  ].join("\n");
}

function renderMarkdownParagraph(title: string, value: string): string {
  const text = value.trim() || "None.";
  return [
    `## ${title}`,
    "",
    text,
    "",
  ].join("\n");
}

function renderMarkdownList(title: string, items: string[]): string {
  if (items.length === 0) {
    return `## ${title}\n\nNone.\n`;
  }
  return [
    `## ${title}`,
    "",
    ...items.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
