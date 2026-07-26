import { basename, isAbsolute } from "node:path";
import {
  RECENT_DOCUMENT_REGISTRY_MAX_FILES,
  type RecentFileMetadata,
  type RunStepFilesystemCompletionEvidence,
  type RunStepToolCall,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";

export const MAX_RECENT_FILES = RECENT_DOCUMENT_REGISTRY_MAX_FILES;
const MAX_SCANNED_RECENT_STEPS = 128;

interface RecentFileStepRow {
  run_id: string;
  step: number;
  tool_calls_json: string;
  verification_json: string;
  created_at: string;
  request_seq: number | null;
  response_seq: number | null;
}

export function readRecentFiles(
  database: ContextDatabase,
  input: {
    streamId: string;
    limit?: number;
  },
): RecentFileMetadata[] {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? MAX_RECENT_FILES), 1),
    MAX_RECENT_FILES,
  );
  const rows = database.prepare([
    "SELECT steps.run_id, steps.step, steps.tool_calls_json,",
    "steps.verification_json, steps.created_at,",
    "(SELECT request.sequence FROM messages request",
    "  WHERE request.run_id = steps.run_id AND request.role != 'assistant'",
    "  ORDER BY request.sequence LIMIT 1) AS request_seq,",
    "(SELECT response.sequence FROM messages response",
    "  WHERE response.run_id = steps.run_id AND response.role = 'assistant'",
    "  ORDER BY response.sequence DESC LIMIT 1) AS response_seq",
    "FROM run_steps steps",
    "JOIN runs ON runs.run_id = steps.run_id",
    "WHERE runs.stream_id = ?",
    "  AND runs.status IN ('done', 'incomplete', 'failed', 'blocked', 'needs_user_input')",
    "  AND steps.status = 'completed'",
    "ORDER BY steps.created_at DESC, runs.run_sequence DESC, steps.step DESC",
    "LIMIT ?",
  ].join(" ")).all(
    input.streamId,
    MAX_SCANNED_RECENT_STEPS,
  ) as unknown as RecentFileStepRow[];

  const recent: RecentFileMetadata[] = [];
  const seenPaths = new Set<string>();
  for (const row of rows) {
    const legacyStepPassed = stepVerificationPassed(row.verification_json);
    const calls = readToolCalls(row.tool_calls_json);
    for (let callIndex = calls.length - 1; callIndex >= 0; callIndex--) {
      const call = calls[callIndex]!;
      if (
        call.tool !== "read_files"
        || call.status !== "success"
        || !callVerificationPassed(call, legacyStepPassed)
      ) {
        continue;
      }
      const evidence = completeReadEvidence(call);
      for (const item of evidence) {
        if (!isAbsolute(item.path) || seenPaths.has(item.path)) continue;
        seenPaths.add(item.path);
        const callId = call.callId
          ?? "call-" + String(callIndex + 1).padStart(3, "0");
        recent.push({
          name: basename(item.path),
          path: item.path,
          lastReadAt: row.created_at,
          evidenceRef: `run:${row.run_id}:step:${row.step}:call:${callId}`,
          coverage: "complete",
          status: "navigation_only",
          ...(row.request_seq !== null ? { requestSeq: Number(row.request_seq) } : {}),
          ...(row.response_seq !== null ? { responseSeq: Number(row.response_seq) } : {}),
          ...(item.sizeBytes !== undefined ? { sizeBytes: item.sizeBytes } : {}),
          ...(item.lineCount !== undefined ? { lineCount: item.lineCount } : {}),
          ...(item.sha256 ? { sha256: item.sha256 } : {}),
        });
        if (recent.length >= limit) return recent;
      }
    }
  }
  return recent;
}

function completeReadEvidence(
  call: RunStepToolCall,
): Array<Extract<RunStepFilesystemCompletionEvidence, { kind: "file_read" }>> {
  return (call.completionEvidence ?? []).filter(
    (
      evidence,
    ): evidence is Extract<RunStepFilesystemCompletionEvidence, { kind: "file_read" }> =>
      evidence.kind === "file_read"
      && evidence.tool === "read_files"
      && evidence.coverage === "complete"
      && evidence.contentAvailable,
  );
}

function readToolCalls(value: string): RunStepToolCall[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as RunStepToolCall[] : [];
  } catch {
    return [];
  }
}

function callVerificationPassed(
  call: RunStepToolCall,
  legacyStepPassed: boolean,
): boolean {
  if (call.verification) {
    return call.verification.status === "passed";
  }
  return legacyStepPassed && call.verificationPassed === true;
}

function stepVerificationPassed(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Boolean(
      parsed
        && typeof parsed === "object"
        && !Array.isArray(parsed)
        && (parsed as Record<string, unknown>)["passed"] === true,
    );
  } catch {
    return false;
  }
}
