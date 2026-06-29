import type {
  GitMemoryConversationRecord,
  GitMemoryTaskId,
} from "./schema.js";

export function readGitMemoryConversationFromMarkdownOrJsonl(
  markdown: string | null,
  jsonl: GitMemoryConversationRecord[],
): GitMemoryConversationRecord[] {
  const parsed = parseGitMemoryConversationMarkdown(markdown);
  if (parsed.length === 0) {
    return jsonl;
  }
  return parsed;
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
