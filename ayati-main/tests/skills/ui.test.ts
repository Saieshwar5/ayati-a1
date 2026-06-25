import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createUiSkill } from "../../src/skills/builtins/ui/index.js";
import { WorkspaceOrchestrator } from "../../src/ui/workspace-orchestrator.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-ui-skill-"));
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  expect(output).toBeTruthy();
  return JSON.parse(output ?? "{}") as Record<string, unknown>;
}

describe("ui built-in skill", () => {
  function createSkill(dataDir: string) {
    return createUiSkill({
      workspaceOrchestrator: new WorkspaceOrchestrator({
        dataDir,
        hyprlandEnabled: false,
      }),
    });
  }

  it("exposes general workspace tools only", () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createSkill(dataDir);

      expect(skill.id).toBe("ui-workspace");
      expect(skill.promptBlock).toContain("CLI window is the protected anchor");
      expect(skill.tools.map((tool) => tool.name)).toEqual([
        "workspace_get_state",
        "workspace_set_layout",
        "workspace_focus_window",
        "workspace_register_window",
        "workspace_reuse_or_open_window",
        "workspace_close_window",
        "workspace_cleanup_unused",
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns general workspace state through the workbench state tool", async () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createSkill(dataDir);
      const stateTool = skill.tools.find((tool) => tool.name === "workspace_get_state");
      expect(stateTool).toBeTruthy();

      const result = await stateTool!.execute({}, { clientId: "local" });

      expect(result.ok).toBe(true);
      const payload = parseOutput(result.output);
      expect(payload["hyprlandAvailable"]).toBe(false);
      expect(payload["activeLayout"]).toBe("30-70");
      expect(payload["maxWindows"]).toBe(5);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
