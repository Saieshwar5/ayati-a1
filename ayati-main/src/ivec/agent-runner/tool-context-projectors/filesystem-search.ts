import { compactInputFields, projectStructuredCall, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const TOOLS = new Set(["search_in_files", "find_files", "list_directory"]);

export const filesystemSearchProjector: ToolContextProjector = {
  id: "filesystem_search_v1",
  supports(call) {
    return TOOLS.has(call.tool);
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: [
        "query",
        "path",
        "roots",
        "pattern",
        "maxDepth",
        "maxResults",
        "includeHidden",
        "caseSensitive",
        "contextLines",
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
        ...(call.rawOutputChars !== undefined ? { rawOutputChars: call.rawOutputChars } : {}),
        ...(call.outputTruncated !== undefined ? { outputTruncated: call.outputTruncated } : {}),
      },
    });
  },
};
