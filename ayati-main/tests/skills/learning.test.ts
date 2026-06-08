import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CourseStore } from "../../src/learning/course-store.js";
import { createLearningSkill } from "../../src/skills/builtins/learning/index.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-learning-skill-"));
}

function parseOutput(output: string | undefined): Record<string, unknown> {
  expect(output).toBeTruthy();
  return JSON.parse(output ?? "{}") as Record<string, unknown>;
}

describe("learning built-in skill", () => {
  it("exposes course management tools", () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createLearningSkill({ courseStore: new CourseStore({ dataDir }) });

      expect(skill.id).toBe("learning");
      expect(skill.promptBlock).toContain("metadata-first");
      expect(skill.tools.map((tool) => tool.name)).toEqual([
        "learning_start_course_session",
        "learning_create_course",
        "learning_list_courses",
        "learning_activate_course",
        "learning_get_active_course",
        "learning_get_active_learning_context",
        "learning_get_active_lesson_context",
        "learning_get_course",
        "learning_update_course_context",
        "learning_plan_next_lesson",
        "learning_continue_course",
        "learning_generate_lesson_page",
        "learning_mark_lesson_done",
        "learning_get_course_progress",
        "learning_add_course_note",
        "learning_record_doubt",
        "learning_search_active_course_context",
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("creates a course, writes a lesson page, and reports progress through tools", async () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createLearningSkill({ courseStore: new CourseStore({ dataDir }) });
      const create = skill.tools.find((tool) => tool.name === "learning_create_course");
      const generate = skill.tools.find((tool) => tool.name === "learning_generate_lesson_page");
      const progress = skill.tools.find((tool) => tool.name === "learning_get_course_progress");
      expect(create).toBeTruthy();
      expect(generate).toBeTruthy();
      expect(progress).toBeTruthy();

      const created = await create!.execute({
        title: "Machine Learning",
        topic: "machine learning",
        preferences: {
          level: "beginner",
          preferredStyle: "visual",
        },
        modules: [{
          title: "Foundations",
          lessons: [{ title: "What is Machine Learning?" }],
        }],
      }, { clientId: "local" });
      expect(created.ok).toBe(true);
      const createdPayload = parseOutput(created.output);
      const course = createdPayload["course"] as Record<string, unknown>;
      expect(course["courseId"]).toBe("machine-learning");

      const generated = await generate!.execute({
        html: "<section><h1>Learning from data</h1></section>",
        assets: [{
          fileName: "diagram.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        }],
      }, { clientId: "local" });
      expect(generated.ok).toBe(true);
      const generatedPayload = parseOutput(generated.output);
      const files = generatedPayload["files"] as Record<string, unknown>;
      expect(existsSync(String(files["htmlPath"]))).toBe(true);
      expect(String((files["assetPaths"] as string[])[0])).toContain("diagram.svg");

      const progressResult = await progress!.execute({}, { clientId: "local" });
      expect(progressResult.ok).toBe(true);
      const progressPayload = parseOutput(progressResult.output);
      const totals = progressPayload["totals"] as Record<string, unknown>;
      expect(totals["generated"]).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("starts a course session with only the first lesson generated", async () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createLearningSkill({ courseStore: new CourseStore({ dataDir }) });
      const start = skill.tools.find((tool) => tool.name === "learning_start_course_session");
      expect(start).toBeTruthy();

      const result = await start!.execute({
        title: "Machine Learning",
        topic: "machine learning",
        preferences: { level: "beginner" },
        modules: [{
          title: "Foundations",
          lessons: [
            { title: "What is Machine Learning?" },
            { title: "Python Basics for ML" },
            { title: "Your First Algorithm" },
          ],
        }],
        firstLesson: {
          title: "What is Machine Learning?",
          summary: "A beginner orientation to learning from data.",
          objectives: ["Understand what machine learning means"],
          html: "<main><h1>What is Machine Learning?</h1></main>",
          metadata: {
            conceptsIntroduced: ["learning from data"],
            firstPrinciples: ["A system needs examples to improve"],
            summaryForAgent: "The first lesson introduces learning from examples.",
          },
        },
      }, { clientId: "local" });

      expect(result.ok).toBe(true);
      const payload = parseOutput(result.output);
      const policy = payload["policy"] as Record<string, unknown>;
      const course = payload["course"] as Record<string, unknown>;
      const totals = course["totals"] as Record<string, unknown>;
      expect(policy["generatedLessonCount"]).toBe(1);
      expect(totals["generated"]).toBe(1);
      expect(totals["planned"]).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("returns active learning context and records doubts through tools", async () => {
    const dataDir = makeTmpDir();
    try {
      const skill = createLearningSkill({ courseStore: new CourseStore({ dataDir }) });
      const start = skill.tools.find((tool) => tool.name === "learning_start_course_session");
      const contextTool = skill.tools.find((tool) => tool.name === "learning_get_active_learning_context");
      const lessonTool = skill.tools.find((tool) => tool.name === "learning_get_active_lesson_context");
      const doubtTool = skill.tools.find((tool) => tool.name === "learning_record_doubt");
      const searchTool = skill.tools.find((tool) => tool.name === "learning_search_active_course_context");
      expect(start).toBeTruthy();
      expect(contextTool).toBeTruthy();
      expect(lessonTool).toBeTruthy();
      expect(doubtTool).toBeTruthy();
      expect(searchTool).toBeTruthy();

      await start!.execute({
        title: "Databases",
        topic: "databases",
        learnerProfile: { qualification: "student" },
        context: { userGoal: "understand why databases exist" },
        firstLesson: {
          title: "Why Store Data?",
          html: "<main><h1>Why Store Data?</h1></main>",
          metadata: {
            conceptsIntroduced: ["durable memory"],
            examplesUsed: ["student marks"],
            summaryForAgent: "The lesson explains durable memory from first principles.",
          },
        },
      }, { clientId: "local" });

      const contextResult = await contextTool!.execute({}, { clientId: "local" });
      const contextPayload = parseOutput(contextResult.output);
      const active = contextPayload["activeLearningContext"] as Record<string, unknown>;
      const course = active["course"] as Record<string, unknown>;
      expect(course["title"]).toBe("Databases");

      const lessonResult = await lessonTool!.execute({}, { clientId: "local" });
      const lessonPayloadResult = parseOutput(lessonResult.output);
      const lessonContext = lessonPayloadResult["lessonContext"] as Record<string, unknown>;
      expect(lessonContext["summaryForAgent"]).toContain("durable memory");

      const doubtResult = await doubtTool!.execute({
        text: "I do not understand durable memory.",
        conceptIds: ["durable memory"],
      }, { clientId: "local" });
      expect(doubtResult.ok).toBe(true);

      const searchResult = await searchTool!.execute({ query: "durable memory" }, { clientId: "local" });
      const searchPayload = parseOutput(searchResult.output);
      const results = searchPayload["results"] as unknown[];
      expect(results.length).toBeGreaterThan(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
