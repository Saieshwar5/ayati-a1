import type { ActToolCallRecord } from "../types.js";
import type { AgentAction } from "./decision.js";

export interface LocalRecovery {
  reason: string;
  action: AgentAction;
}

export function planLocalRecovery(action: AgentAction, toolCalls: ActToolCallRecord[]): LocalRecovery | null {
  const failed = toolCalls.find((call) => call.error || call.result?.operationStatus === "failed");
  if (!failed) {
    return null;
  }

  if (isParentDirectoryFailure(failed) && supportsCreateDirsRetry(failed)) {
    const retryAction = withCreateDirs(action, failed.tool);
    if (retryAction) {
      return {
        reason: `${failed.tool} failed because a parent directory was missing; retrying with createDirs=true.`,
        action: retryAction,
      };
    }
  }

  return null;
}

function isParentDirectoryFailure(call: ActToolCallRecord): boolean {
  const code = call.result?.code ?? call.code;
  if (code === "PARENT_DIR_MISSING" || code === "MISSING_PATH" || code === "ENOENT") {
    return true;
  }

  const error = `${call.error ?? ""} ${call.result?.message ?? ""}`.toLowerCase();
  return error.includes("enoent") || error.includes("no such file") || error.includes("parent director");
}

function supportsCreateDirsRetry(call: ActToolCallRecord): boolean {
  return call.tool === "write_files"
    && isRecord(call.input)
    && call.input["createDirs"] !== true;
}

function withCreateDirs(action: AgentAction, failedTool: string): AgentAction | null {
  let changed = false;
  const calls = action.calls.map((call) => {
    if (call.tool !== failedTool || !isRecord(call.input) || call.input["createDirs"] === true) {
      return call;
    }
    changed = true;
    return {
      ...call,
      input: {
        ...call.input,
        createDirs: true,
      },
    };
  });

  return changed
    ? {
        ...action,
        calls,
      }
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
