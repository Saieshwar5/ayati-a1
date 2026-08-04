import { compactInputFields, projectStructuredCall, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

export const gitReadProjector: ToolContextProjector = {
  id: "git_read_v1",
  supports(call) {
    return call.tool === "git_read";
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: [
        "repositoryPath",
        "operation",
        "revision",
        "baseRevision",
        "targetRevision",
        "path",
        "query",
        "diffScope",
        "limit",
        "maxChars",
        "includePatch",
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
      previewSource: call.output,
    });
  },
};
