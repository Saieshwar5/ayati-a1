import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUiSkill } from "../../src/skills/builtins/ui/index.js";
import { LearningWorkspaceController } from "../../src/ui/learning-workspace.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-ui-skill-"));
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  expect(output).toBeTruthy();
  return JSON.parse(output ?? "{}") as Record<string, unknown>;
}

describe("ui built-in skill", () => {
  it("exposes scoped learning workspace tools", () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createUiSkill({
        learningWorkspace: new LearningWorkspaceController({
          projectRoot: dataDir,
          dataDir,
          httpBaseUrl: "http://127.0.0.1:8081",
          hyprlandEnabled: false,
        }),
      });

      expect(skill.id).toBe("ui-workspace");
      expect(skill.promptBlock).toContain("Ayati-owned windows");
      expect(skill.tools.map((tool) => tool.name)).toEqual([
        "ui_open_learning_workspace",
        "ui_focus_learning_workspace",
        "ui_show_learning_course",
        "ui_show_learning_lesson",
        "ui_get_learning_workspace_state",
        "ui_close_learning_workspace",
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns learning workspace state through the state tool", async () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createUiSkill({
        learningWorkspace: new LearningWorkspaceController({
          projectRoot: dataDir,
          dataDir,
          httpBaseUrl: "http://127.0.0.1:8081",
          hyprlandEnabled: false,
        }),
      });
      const stateTool = skill.tools.find((tool) => tool.name === "ui_get_learning_workspace_state");
      expect(stateTool).toBeTruthy();

      const result = await stateTool!.execute({}, { clientId: "local" });

      expect(result.ok).toBe(true);
      const payload = parseOutput(result.output);
      expect(payload["isOpen"]).toBe(false);
      expect(payload["launchStatus"]).toBe("not_started");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
