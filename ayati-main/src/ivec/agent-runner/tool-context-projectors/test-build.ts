import { omitFields, projectStructuredCall, readCommand, readMetadata } from "./shared.js";
import type { ToolContextProjector } from "./types.js";

const SHELL_TOOLS = new Set(["shell", "shell_run_script"]);
const TEST_BUILD_COMMAND = /(^|\s)(test|vitest|jest|pytest|cargo\s+test|go\s+test|build|tsc|typecheck|lint)(\s|$)/i;

export const testBuildProjector: ToolContextProjector = {
  id: "test_build_v1",
  supports(call) {
    return SHELL_TOOLS.has(call.tool) && TEST_BUILD_COMMAND.test(readCommand(call.input));
  },
  project(call, mode) {
    const command = readCommand(call.input);
    return projectStructuredCall({
      projectorId: this.id,
      call,
      mode,
      compactInput: { command },
      summary: {
        tool: call.tool,
        category: "test_or_build",
        status: call.status,
        command,
        result: omitFields(readMetadata(call), ["stdoutPreview", "stderrPreview", "outputPreview"]),
        ...(call.code ? { code: call.code } : {}),
        ...(call.error ? { error: call.error } : {}),
      },
      previewSource: call.output ?? "",
    });
  },
};
