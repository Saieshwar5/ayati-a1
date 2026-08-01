import { compactInputFields, projectStructuredCall, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const HISTORY_TOOLS = new Set([
  "agent_history_search",
  "agent_conversation_read",
  "agent_history_read",
]);

export const historyProjector: ToolContextProjector = {
  id: "agent_history_v1",
  supports(call) {
    return HISTORY_TOOLS.has(call.tool);
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: [
        "query",
        "kinds",
        "limit",
        "cursor",
        "beforeSeq",
        "ref",
        "fromSeq",
        "toSeq",
        "maxChars",
        "offsetChars",
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
