import { describe, expect, it, vi } from "vitest";
import {
  createControllerStateToolRuntime,
  STATE_MANAGEMENT_TOOL_SCHEMA,
} from "../../src/ivec/controller-state-tool.js";

describe("createControllerStateToolRuntime", () => {
  it("exposes only state_management and reads summary windows", async () => {
    const runtime = createControllerStateToolRuntime({
      readSummaryWindow: vi.fn().mockResolvedValue({ window: { from: 1, to: 2 }, steps: [] }),
      readStepFull: vi.fn().mockResolvedValue(null),
    } as never);

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      STATE_MANAGEMENT_TOOL_SCHEMA.name,
    ]);

    const payload = JSON.parse(await runtime.executeTool("state_management", {
      action: "read_summary_window",
      window: { from: 1, to: 2 },
    })) as Record<string, unknown>;

    expect(payload["ok"]).toBe(true);
    expect(payload["action"]).toBe("read_summary_window");
  });
});
