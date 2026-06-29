import type {
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryRunId,
  GitMemoryTaskId,
} from "./schema.js";

export interface ConversationMarkdownMetadata {
  taskId?: GitMemoryTaskId;
  runId?: GitMemoryRunId;
  branch?: string;
}

export function parseGitMemoryConversationMarkdown(
  value: string | null,
): GitMemoryConversationRecord[] {
  if (!value?.trim() || value.trim() === "# Conversation") {
    return [];
  }
  const records: GitMemoryConversationRecord[] = [];
  const lines = value.split(/\r?\n/);
  let current: {
    at: string;
    role: GitMemoryConversationRecord["role"];
    body: string[];
    taskId?: GitMemoryTaskId;
    runId?: string;
    branch?: string;
  } | null = null;

  const flush = () => {
    if (!current) {
      return;
    }
    const body = current.body.join("\n").trim();
    const seq = records.length + 1;
    records.push({
      seq,
      role: current.role,
      at: current.at,
      text: body,
      ...(current.taskId ? { taskId: current.taskId } : {}),
      ...(current.runId ? { runId: current.runId } : {}),
      ...(current.branch ? { branch: current.branch } : {}),
    });
  };

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s+(User|Assistant|System)\s*$/.exec(line);
    if (heading) {
      flush();
      current = {
        at: heading[1]?.trim() ?? "",
        role: heading[2]?.toLowerCase() as GitMemoryConversationRecord["role"],
        body: [],
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const task = /^Task:\s*(\S+)\s*$/.exec(line);
    if (task && current.body.every((entry) => entry.trim() === "")) {
      current.taskId = task[1];
      continue;
    }
    const run = /^Run:\s*(\S+)\s*$/.exec(line);
    if (run && current.body.every((entry) => entry.trim() === "")) {
      current.runId = run[1];
      continue;
    }
    const branch = /^Branch:\s*(\S+)\s*$/.exec(line);
    if (branch && current.body.every((entry) => entry.trim() === "")) {
      current.branch = branch[1];
      continue;
    }
    current.body.push(line);
  }
  flush();
  return records;
}

export function appendGitMemoryConversationMarkdown(
  existing: string | null,
  record: GitMemoryConversationRecord,
): string {
  return appendGitMemoryConversationMarkdownRecords(existing, [record]);
}

export function renderGitMemoryConversationMarkdownDocument(
  records: GitMemoryConversationRecord[],
  metadata: ConversationMarkdownMetadata = {},
): string {
  return appendGitMemoryConversationMarkdownRecords("# Conversation\n", records, metadata);
}

export function appendGitMemoryConversationMarkdownRecords(
  existing: string | null,
  records: GitMemoryConversationRecord[],
  metadata: ConversationMarkdownMetadata = {},
): string {
  const base = existing?.trimEnd() || "# Conversation";
  let output = base;
  for (const record of records) {
    const block = renderGitMemoryConversationMarkdownBlock(record, metadata).trimEnd();
    if (!output.includes(block)) {
      output = `${output}\n\n${block}`;
    }
  }
  return `${output.trimEnd()}\n`;
}

export function renderGitMemoryConversationMarkdownBlock(
  record: GitMemoryConversationRecord,
  metadata: ConversationMarkdownMetadata = {},
): string {
  const taskId = metadata.taskId ?? record.taskId ?? undefined;
  const runId = metadata.runId ?? record.runId ?? undefined;
  const branch = metadata.branch ?? record.branch ?? undefined;
  const lines = [
    `## ${record.at} ${capitalizeRole(record.role)}`,
    "",
  ];
  if (taskId) {
    lines.push(`Task: ${taskId}`);
  }
  if (runId) {
    lines.push(`Run: ${runId}`);
  }
  if (branch && branch !== "main") {
    lines.push(`Branch: ${branch}`);
  }
  if (taskId || runId || (branch && branch !== "main")) {
    lines.push("");
  }
  lines.push(record.text?.trim() || `[content: ${record.contentRef ?? "unavailable"}]`);
  return `${lines.join("\n")}\n`;
}

function capitalizeRole(role: GitMemoryConversationRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}
