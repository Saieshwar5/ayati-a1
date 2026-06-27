import type { AssetId, RunId, SessionId, WorkId } from "./ids.js";
import type { GitRef, WorkBranchName } from "./refs.js";

export const SESSION_META_PATH = "session/meta.json";
export const SESSION_CONVERSATION_PATH = "session/conversation.jsonl";
export const SESSION_ASSETS_PATH = "session/assets.jsonl";
export const SESSION_EVENTS_PATH = "session/events.jsonl";

export interface SessionMetaFile {
  schemaVersion: 1;
  sessionId: SessionId;
  date: SessionId;
  timezone: string;
  createdAt: string;
}

export type ConversationRole = "user" | "assistant" | "system";

export interface ConversationRecord {
  seq: number;
  role: ConversationRole;
  at: string;
  text: string;
}

export type SessionAssetKind = "user_file" | "agent_file" | "document" | "directory" | "artifact";

export interface SessionAssetRecord {
  assetId: AssetId;
  kind: SessionAssetKind;
  name: string;
  path: string;
  sha256?: string;
  mimeType?: string;
  createdAt: string;
}

export type SessionEventRecord =
  | {
      seq: number;
      type: "session_started";
      at: string;
      sessionId: SessionId;
    }
  | {
      seq: number;
      type: "asset_registered";
      at: string;
      assetId: AssetId;
    }
  | {
      seq: number;
      type: "task_branch_created";
      at: string;
      workId: WorkId;
      branch: WorkBranchName;
      ref: GitRef;
    }
  | {
      seq: number;
      type: "focus_changed";
      at: string;
      to: GitRef;
      from?: GitRef;
    }
  | {
      seq: number;
      type: "run_started";
      at: string;
      runId: RunId;
      workId: WorkId;
    }
  | {
      seq: number;
      type: "run_committed";
      at: string;
      runId: RunId;
      workId: WorkId;
      commit: string;
    }
  | {
      seq: number;
      type: "session_closed";
      at: string;
      reason?: string;
    };
