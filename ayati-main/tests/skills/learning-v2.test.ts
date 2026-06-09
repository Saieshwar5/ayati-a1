import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LearningFileStore } from "../../src/learning/file-store.js";
import { createLearningFileSkill } from "../../src/skills/builtins/learning-v2/index.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-learning-v2-skill-"));
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  expect(output).toBeTruthy();
  return JSON.parse(output ?? "{}") as Record<string, unknown>;
}

describe("learning V2 built-in skill", () => {
  it("exposes only the filesystem status and workspace show tools", () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createLearningFileSkill({
        learningFileStore: new LearningFileStore({ dataDir }),
      });

      expect(skill.id).toBe("learning-v2");
      expect(skill.tools.map((tool) => tool.name)).toEqual([
        "learning_status",
        "learning_workspace_show",
      ]);
      expect(skill.promptBlock).toContain("filesystem-native");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns learning filesystem status through the status tool", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new LearningFileStore({ dataDir });
      const skill = createLearningFileSkill({ learningFileStore: store });
      const statusTool = skill.tools.find((tool) => tool.name === "learning_status");

      const result = await statusTool!.execute({}, { clientId: "local" });

      expect(result.ok).toBe(true);
      const payload = parseOutput(result.output);
      expect(payload["rootPath"]).toBe(join(dataDir, "learning"));
      expect(payload["activeState"]).toMatchObject({ learningMode: "inactive" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("marks a learning turn before showing the workspace", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new LearningFileStore({ dataDir });
      await store.ensureBase();
      const lessonDir = join(dataDir, "learning", "interests", "databases", "lessons", "001-why-store-data");
      mkdirSync(lessonDir, { recursive: true });
      writeFileSync(join(dataDir, "learning", "interests", "databases", "course.md"), "# Databases\n", "utf8");
      writeFileSync(join(dataDir, "learning", "interests", "databases", "index.md"), "# Learning Index\n", "utf8");
      writeFileSync(join(lessonDir, "lesson.md"), "# Why Store Data\n", "utf8");
      writeFileSync(join(lessonDir, "view.html"), "<main>Databases</main>", "utf8");
      writeFileSync(store.activePath(), JSON.stringify({
        schemaVersion: 2,
        activeInterestId: "databases",
        learningMode: "inactive",
        updatedAt: "2026-06-08T06:00:00.000Z",
      }, null, 2), "utf8");

      const skill = createLearningFileSkill({ learningFileStore: store });
      const showTool = skill.tools.find((tool) => tool.name === "learning_workspace_show");
      const result = await showTool!.execute({ lessonId: "001-why-store-data" }, { clientId: "local" });

      expect(result.ok).toBe(true);
      const payload = parseOutput(result.output);
      const status = payload["status"] as Record<string, unknown>;
      const activeState = status["activeState"] as Record<string, unknown>;
      expect(activeState["learningMode"]).toBe("learning");
      expect(activeState["activeViewPath"]).toBe("interests/databases/lessons/001-why-store-data/view.html");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
