import type {
  GitMemoryTaskId,
  GitMemoryTaskStatus,
} from "./schema.js";

export interface GitMemoryTaskMarkdownFile {
  taskId: GitMemoryTaskId;
  title: string;
  objective: string;
  status: GitMemoryTaskStatus;
  createdAt: string;
  updatedAt: string;
}

export function renderGitMemoryTaskMarkdown(task: GitMemoryTaskMarkdownFile): string {
  return [
    `# ${task.title}`,
    "",
    `Task: ${task.taskId}`,
    `Status: ${task.status}`,
    `Created: ${task.createdAt}`,
    `Updated: ${task.updatedAt}`,
    "",
    "## Objective",
    "",
    task.objective,
    "",
  ].join("\n");
}

export function parseGitMemoryTaskMarkdown(markdown: string | null): GitMemoryTaskMarkdownFile | null {
  if (!markdown?.trim()) {
    return null;
  }
  const title = firstMatch(markdown, /^#\s+(.+)$/m);
  const taskId = firstMatch(markdown, /^Task:\s*(.+)$/m);
  const status = firstMatch(markdown, /^Status:\s*(.+)$/m);
  const createdAt = firstMatch(markdown, /^Created:\s*(.+)$/m);
  const updatedAt = firstMatch(markdown, /^Updated:\s*(.+)$/m);
  const objective = markdownSection(markdown, "Objective");
  if (!title || !taskId || !isGitMemoryTaskStatus(status) || !createdAt || !updatedAt || !objective) {
    return null;
  }
  return {
    taskId,
    title,
    objective,
    status,
    createdAt,
    updatedAt,
  };
}

function firstMatch(markdown: string, pattern: RegExp): string {
  return pattern.exec(markdown)?.[1]?.trim() ?? "";
}

function markdownSection(markdown: string, title: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${title}`);
  if (start < 0) {
    return "";
  }
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line)) {
      break;
    }
    body.push(line);
  }
  return body.join("\n").trim();
}

function isGitMemoryTaskStatus(value: string): value is GitMemoryTaskStatus {
  return value === "open"
    || value === "in_progress"
    || value === "blocked"
    || value === "done"
    || value === "abandoned";
}
