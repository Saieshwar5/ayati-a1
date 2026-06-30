import type {
  GitMemoryRunFile,
  GitMemoryTaskId,
  GitMemoryTaskStateFile,
  GitMemoryTaskStatus,
} from "./schema.js";

export interface RenderGitMemoryTaskNotesInput {
  taskId: GitMemoryTaskId;
  title: string;
  objective: string;
  status: GitMemoryTaskStatus;
  state: GitMemoryTaskStateFile;
  latestRun?: GitMemoryRunFile;
}

export function renderGitMemoryTaskNotes(input: RenderGitMemoryTaskNotesInput): string {
  const latestRun = input.latestRun;
  const decisions = latestRun?.decisions ?? [];
  return [
    `# ${input.title}`,
    "",
    `Task: ${input.taskId}`,
    `Status: ${input.state.status || input.status}`,
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
    renderMarkdownList("Completed", input.state.completed),
    renderMarkdownList("Open Work", input.state.open),
    renderMarkdownList("Blockers", input.state.blockers),
    renderMarkdownList("Facts", input.state.facts),
    renderMarkdownList("Decisions", decisions),
    "## Next",
    "",
    input.state.next,
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
