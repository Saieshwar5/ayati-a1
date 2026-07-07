import type {
  GitMemoryRunFile,
  GitMemoryTaskId,
  GitMemoryTaskStateFile,
  GitMemoryTaskStatus,
} from "./schema.js";

export interface RenderGitMemoryTaskNotesInput {
  taskId: GitMemoryTaskId;
  branch?: string;
  title: string;
  objective: string;
  status: GitMemoryTaskStatus;
  state: GitMemoryTaskStateFile;
  latestRun?: GitMemoryRunFile;
  updatedAt?: string;
  files?: string[];
  recentWork?: string[];
  searchTerms?: string[];
}

export function renderGitMemoryTaskNotes(input: RenderGitMemoryTaskNotesInput): string {
  const latestRun = input.latestRun;
  const decisions = latestRun?.decisions ?? [];
  const updatedAt = input.updatedAt ?? input.state.updatedAt;
  const completed = input.state.progress.completed;
  const open = input.state.progress.open;
  const blockers = input.state.progress.blockers;
  const facts = input.state.memory.facts.map((fact) => fact.text);
  const next = input.state.progress.next;
  const files = unique([
    ...input.state.context.importantFiles,
    ...(input.files ?? []),
    ...(latestRun?.changedFiles ?? []),
  ]);
  const artifactLines = input.state.memory.files.map((file) => {
    const source = file.source === "user_attachment" ? "user attachment" : "agent workspace";
    return `${file.identity.name} (${file.path}; ${source}; ${file.status})`;
  });
  const recentWork = unique([
    ...(input.recentWork ?? []),
    ...(latestRun?.workPerformed ?? []),
  ]);
  const searchTerms = unique([
    ...deriveSearchTerms([
      input.taskId,
      input.branch ?? "",
      input.title,
      input.objective,
      input.state.status || input.status,
      input.state.summary,
      next,
      ...completed,
      ...open,
      ...blockers,
      ...facts,
      ...decisions,
      ...files,
      ...recentWork,
      latestRun?.summary ?? "",
      ...(latestRun?.newFacts ?? []),
    ]),
    ...(input.searchTerms ?? []),
  ]);
  return [
    `# ${input.title}`,
    "",
    `Task: ${input.taskId}`,
    ...(input.branch ? [`Branch: ${input.branch}`] : []),
    `Status: ${input.state.status || input.status}`,
    ...(updatedAt ? [`Updated: ${updatedAt}`] : []),
    ...(latestRun ? [`Latest Run: ${latestRun.runId}`] : []),
    "",
    "## Objective",
    "",
    input.objective,
    "",
    "## Summary",
    "",
    input.state.summary,
    "",
    renderMarkdownList("Completed", completed),
    renderMarkdownList("Open Work", open),
    renderMarkdownList("Blockers", blockers),
    renderMarkdownList("Facts", facts),
    renderMarkdownList("Decisions", decisions),
    renderMarkdownList("Files", files),
    renderMarkdownList("Artifacts", artifactLines),
    renderMarkdownList("Recent Work", recentWork),
    renderSearchTerms(searchTerms),
    "## Next",
    "",
    next,
    "",
  ].join("\n");
}

function renderSearchTerms(terms: string[]): string {
  if (terms.length === 0) {
    return "## Search Terms\n\nNone.\n";
  }
  return [
    "## Search Terms",
    "",
    terms.join(" "),
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

function deriveSearchTerms(values: string[]): string[] {
  return unique(values
    .flatMap((value) => value.toLowerCase().split(/[^a-z0-9]+/g))
    .filter((term) => term.length >= 2)
    .filter((term) => !COMMON_SEARCH_WORDS.has(term)));
}

function unique(values: string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value, index, all) => all.indexOf(value) === index);
}

const COMMON_SEARCH_WORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "has",
  "into",
  "that",
  "the",
  "this",
  "with",
]);
