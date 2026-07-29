import type { PromptRunToolCallContext } from "../run-tool-call-context.js";
import { compactInputFields, projectStructuredCall, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const TOOLS = new Set([
  "write_files",
  "patch_files",
  "copy",
  "move",
  "delete",
  "create_directory",
  "set_permissions",
]);

export const filesystemWriteProjector: ToolContextProjector = {
  id: "filesystem_write_v1",
  supports(call) {
    return TOOLS.has(call.tool);
  },
  project(call, mode) {
    const compactInput = compactWriteInput(call);
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
        ...(call.artifacts?.length ? { artifacts: call.artifacts } : {}),
      },
    });
  },
};

function compactWriteInput(call: PromptRunToolCallContext): unknown {
  if (call.tool === "write_files") {
    return compactInputFields(call.input, {
      keep: ["createParents"],
      arrayObjectFields: { files: ["path"] },
    });
  }
  if (call.tool === "patch_files") {
    return compactInputFields(call.input, {
      arrayObjectFields: { files: ["path"] },
    });
  }
  if (call.tool === "set_permissions") {
    return compactInputFields(call.input, {
      arrayObjectFields: { files: ["path", "mode"] },
    });
  }
  return compactInputFields(call.input, {
    keep: ["path", "source", "destination", "from", "to", "recursive", "createParents"],
  });
}
