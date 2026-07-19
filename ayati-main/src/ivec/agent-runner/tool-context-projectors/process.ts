import { compactInputFields, omitFields, projectStructuredCall, readCommand, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const TOOLS = new Set([
  "process_run",
  "process_start",
  "process_poll",
  "process_send_input",
  "process_stop",
]);

export const processProjector: ToolContextProjector = {
  id: "process_v1",
  supports(call) {
    return TOOLS.has(call.tool);
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: ["executable", "args", "workdir", "cwd", "timeoutMs", "sessionId", "input"],
    });
    return projectStructuredCall({
      projectorId: this.id,
      call,
      mode,
      compactInput,
      summary: {
        tool: call.tool,
        status: call.status,
        command: readCommand(call.input),
        result: omitFields(readMetadata(call), ["stdoutPreview", "stderrPreview", "outputPreview"]),
        ...(call.code ? { code: call.code } : {}),
        ...(call.error ? { error: call.error } : {}),
      },
      previewSource: processPreview(call),
    });
  },
};

function processPreview(call: Parameters<ToolContextProjector["project"]>[0]): string {
  const metadata = readMetadata(call);
  const stdout = typeof metadata["stdoutPreview"] === "string" ? metadata["stdoutPreview"] : "";
  const stderr = typeof metadata["stderrPreview"] === "string" ? metadata["stderrPreview"] : "";
  return [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : "", call.output ?? ""]
    .filter(Boolean)
    .join("\n\n");
}
