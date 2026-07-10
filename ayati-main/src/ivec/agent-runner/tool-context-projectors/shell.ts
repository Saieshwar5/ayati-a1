import { compactInputFields, omitFields, projectStructuredCall, readCommand, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const TOOLS = new Set([
  "shell",
  "shell_run_script",
  "shell_session_start",
  "shell_session_write",
  "shell_session_close",
]);

export const shellProjector: ToolContextProjector = {
  id: "shell_v1",
  supports(call) {
    return TOOLS.has(call.tool);
  },
  project(call, mode) {
    const compactInput = compactInputFields(call.input, {
      keep: ["cmd", "command", "script", "workdir", "cwd", "timeoutMs", "sessionId", "chars"],
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
      previewSource: shellPreview(call),
    });
  },
};

function shellPreview(call: Parameters<ToolContextProjector["project"]>[0]): string {
  const metadata = readMetadata(call);
  const stdout = typeof metadata["stdoutPreview"] === "string" ? metadata["stdoutPreview"] : "";
  const stderr = typeof metadata["stderrPreview"] === "string" ? metadata["stderrPreview"] : "";
  return [stdout ? `stdout:\n${stdout}` : "", stderr ? `stderr:\n${stderr}` : "", call.output ?? ""]
    .filter(Boolean)
    .join("\n\n");
}
