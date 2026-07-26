import { describe, expect, it } from "vitest";
import {
  createPersonalMemoryHotContextSource,
  HotContextRuntime,
  WORKSTREAMS_RECENT_HOT_CONTEXT_KEY,
} from "../../src/ivec/hot-context/index.js";
import { createContextSkill } from "../../src/skills/builtins/context/index.js";

describe("context_load", () => {
  it("returns a small receipt and mounts full content outside the tool result", async () => {
    const content = "The user prefers compact implementation plans.";
    const runtime = new HotContextRuntime({
      sources: [
        createPersonalMemoryHotContextSource({
          getSnapshot: () => content,
        }),
      ],
    });
    const tool = createContextSkill({ hotContextRuntime: runtime }).tools[0]!;

    const result = await tool.execute(
      { keys: ["personal.memory"] },
      {
        clientId: "client-1",
        runId: "RUN-1",
        stepNumber: 3,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(content);
    expect(result.v2?.structuredContent).toMatchObject({
      loaded: ["personal.memory"],
      rejected: [],
    });
    expect(result.meta).toEqual({
      stateUpdates: [{ type: "sync_hot_context_mounts" }],
    });
    expect(runtime.project("client-1", "RUN-1").loaded).toEqual([
      expect.objectContaining({
        key: "personal.memory",
        content,
        mountedAtStep: 3,
      }),
    ]);
  });

  it("fails clearly when no advertised entry is available", async () => {
    const runtime = new HotContextRuntime({
      sources: [
        createPersonalMemoryHotContextSource({
          getSnapshot: () => "",
        }),
      ],
    });
    const tool = createContextSkill({ hotContextRuntime: runtime }).tools[0]!;

    const result = await tool.execute(
      { keys: ["personal.memory"] },
      {
        clientId: "client-1",
        runId: "RUN-1",
        stepNumber: 1,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.v2).toMatchObject({
      code: "HOT_CONTEXT_NOT_LOADED",
      structuredContent: {
        rejected: [{ key: "personal.memory", reason: "not_available" }],
      },
    });
  });

  it("exposes the run-scoped recent-workstream key in the native tool schema", () => {
    const runtime = new HotContextRuntime({
      sources: [],
      runScopedKeys: [WORKSTREAMS_RECENT_HOT_CONTEXT_KEY],
    });
    const tool = createContextSkill({ hotContextRuntime: runtime }).tools[0]!;
    const properties = tool.inputSchema.properties as {
      keys: { items: { enum: string[] } };
    };

    expect(properties.keys.items.enum).toContain(WORKSTREAMS_RECENT_HOT_CONTEXT_KEY);
  });
});
