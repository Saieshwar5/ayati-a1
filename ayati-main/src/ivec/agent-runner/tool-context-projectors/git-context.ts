import { compactInputFields, projectStructuredCall, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

export const gitContextProjector: ToolContextProjector = {
  id: "git_context_v1",
  supports(call) {
    return call.tool.startsWith("git_context_");
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: [
        "sessionId",
        "taskId",
        "workId",
        "runId",
        "step",
        "callId",
        "ref",
        "query",
        "limit",
        "fromSeq",
        "toSeq",
        "reason",
      ],
    });
    return projectStructuredCall({
      projectorId: this.id,
      call,
      mode,
      compactInput,
      summary: {
        tool: call.tool,
        status: call.status,
        request: compactInput,
        result: readMetadata(call),
        ...(call.code ? { code: call.code } : {}),
        ...(call.error ? { error: call.error } : {}),
      },
    });
  },
};
