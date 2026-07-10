import type { PromptRunToolCallContext } from "../run-tool-call-context.js";
import { compactInputFields, projectStructuredCall, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const TOOLS = new Set(["read_files", "read_files__single", "inspect_paths"]);

export const filesystemReadProjector: ToolContextProjector = {
  id: "filesystem_read_v1",
  supports(call) {
    return TOOLS.has(call.tool);
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: ["path", "mode", "query", "startLine", "lineCount", "contextLines", "maxBlocks"],
      arrayObjectFields: {
        files: ["path", "mode", "query", "startLine", "lineCount", "contextLines", "maxBlocks"],
        paths: ["path", "sha256"],
      },
    });
    return projectStructuredCall({
      projectorId: this.id,
      call,
      mode,
      compactInput,
      summary: summary(call, compactInput),
    });
  },
};

function summary(call: PromptRunToolCallContext, compactInput: unknown): Record<string, unknown> {
  return {
    tool: call.tool,
    status: call.status,
    request: compactInput,
    result: readMetadata(call),
    ...(call.code ? { code: call.code } : {}),
    ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
    ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
  };
}
