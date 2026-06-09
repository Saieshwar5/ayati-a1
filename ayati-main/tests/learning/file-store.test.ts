import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LearningFileStore } from "../../src/learning/file-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-learning-v2-"));
}

describe("LearningFileStore", () => {
  it("creates the filesystem protocol files and reports empty status", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new LearningFileStore({ dataDir, now: () => new Date("2026-06-08T06:00:00.000Z") });
      const status = await store.getStatus();

      expect(status.rootPath).toBe(join(dataDir, "learning"));
      expect(existsSync(status.protocolPath)).toBe(true);
      expect(existsSync(status.preferencesPath)).toBe(true);
      expect(existsSync(status.activePath)).toBe(true);
      expect(status.activeState.learningMode).toBe("inactive");
      expect(status.interests).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("loads compact context only for learning-related turns", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new LearningFileStore({ dataDir, now: () => new Date("2026-06-08T06:00:00.000Z") });
      await store.ensureBase();
      const interestDir = join(dataDir, "learning", "interests", "machine-learning");
      mkdirSync(join(interestDir, "lessons", "001-why-machines-learn"), { recursive: true });
      writeFileSync(join(interestDir, "course.md"), "# Machine Learning\n\n## Why\nBuild intuition.", "utf8");
      writeFileSync(join(interestDir, "index.md"), "# Learning Index\n\n## Current Big Question\nWhy can examples teach?", "utf8");
      writeFileSync(join(interestDir, "feedback.md"), "# Feedback\n\n- I am confused about examples.", "utf8");
      writeFileSync(join(interestDir, "lessons", "001-why-machines-learn", "lesson.md"), "# Why Machines Learn\n\n## The Question\nWhy do examples help?", "utf8");
      writeFileSync(join(interestDir, "lessons", "001-why-machines-learn", "view.html"), "<main>lesson</main>", "utf8");
      writeFileSync(store.activePath(), JSON.stringify({
        schemaVersion: 2,
        activeInterestId: "machine-learning",
        learningMode: "inactive",
        updatedAt: "2026-06-08T06:00:00.000Z",
      }, null, 2), "utf8");

      const unrelated = await store.renderPromptContext("what time is it?");
      expect(unrelated.included).toBe(false);

      const related = await store.renderPromptContext("continue learning");
      expect(related.included).toBe(true);
      expect(related.context).toContain("# Active Learning V2 Context");
      expect(related.context).toContain("Machine Learning");
      expect(related.context).toContain("Why can examples teach?");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
