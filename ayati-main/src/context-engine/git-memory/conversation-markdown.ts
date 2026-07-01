import type {
  GitMemoryConversationRecord,
  GitMemoryConversationRole,
  GitMemoryRunId,
  GitMemoryTaskId,
} from "./schema.js";

export interface ConversationMarkdownMetadata {
  sessionId?: string;
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

export function renderGitMemoryConversationMessageFile(
  record: GitMemoryConversationRecord,
  metadata: ConversationMarkdownMetadata = {},
): string {
  const taskId = metadata.taskId ?? record.taskId ?? undefined;
  const runId = metadata.runId ?? record.runId ?? undefined;
  const branch = metadata.branch ?? record.branch ?? undefined;
  const lines = [
    `# Message ${formatMessageSeq(record.seq)}`,
    "",
    `Role: ${capitalizeRole(record.role)}`,
    `At: ${record.at}`,
    ...(metadata.sessionId ? [`Session: ${metadata.sessionId}`] : []),
    ...(taskId ? [`Task: ${taskId}`] : []),
    ...(runId ? [`Run: ${runId}`] : []),
    ...(branch && branch !== "main" ? [`Branch: ${branch}`] : []),
    "",
    record.text?.trim() || `[content: ${record.contentRef ?? "unavailable"}]`,
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseGitMemoryConversationMessageFile(
  value: string | null,
): GitMemoryConversationRecord | null {
  if (!value?.trim()) {
    return null;
  }
  const lines = value.split(/\r?\n/);
  const heading = /^#\s+Message\s+(\d+)\s*$/.exec(lines[0] ?? "");
  if (!heading) {
    return null;
  }
  const seq = Number(heading[1]);
  if (!Number.isInteger(seq) || seq < 1) {
    return null;
  }

  let role: GitMemoryConversationRole | undefined;
  let at: string | undefined;
  let taskId: GitMemoryTaskId | undefined;
  let runId: GitMemoryRunId | undefined;
  let branch: string | undefined;
  let bodyStart = -1;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      if (role && at) {
        bodyStart = index + 1;
      }
      continue;
    }
    if (bodyStart >= 0) {
      break;
    }
    const separator = line.indexOf(":");
    if (separator < 0) {
      return null;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const rawValue = line.slice(separator + 1).trim();
    if (key === "role") {
      const normalizedRole = rawValue.toLowerCase();
      if (normalizedRole === "user" || normalizedRole === "assistant" || normalizedRole === "system") {
        role = normalizedRole;
      }
    } else if (key === "at") {
      at = rawValue;
    } else if (key === "task") {
      taskId = rawValue;
    } else if (key === "run") {
      runId = rawValue;
    } else if (key === "branch") {
      branch = rawValue;
    }
  }

  if (!role || !at || bodyStart < 0) {
    return null;
  }
  const text = lines.slice(bodyStart).join("\n").trim();
  return {
    seq,
    role,
    at,
    text,
    ...(taskId ? { taskId } : {}),
    ...(runId ? { runId } : {}),
    ...(branch ? { branch } : {}),
  };
}

export function parseGitMemoryConversationMessageFiles(
  files: Array<{ path: string; content: string | null }>,
): GitMemoryConversationRecord[] {
  return files
    .map((file) => parseGitMemoryConversationMessageFile(file.content))
    .filter((record): record is GitMemoryConversationRecord => record !== null)
    .sort((left, right) => left.seq - right.seq || roleOrder(left.role) - roleOrder(right.role));
}

function capitalizeRole(role: GitMemoryConversationRole): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatMessageSeq(seq: number): string {
  return String(seq).padStart(6, "0");
}

function roleOrder(role: GitMemoryConversationRole): number {
  if (role === "user") return 0;
  if (role === "assistant") return 1;
  return 2;
}
