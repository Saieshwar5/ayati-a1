import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CourseStore } from "../../src/learning/course-store.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ayati-learning-"));
}

describe("CourseStore", () => {
  it("creates metadata-first courses and tracks the active course per client", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new CourseStore({ dataDir });

      const first = await store.createCourse({
        clientId: "local",
        title: "Machine Learning",
        topic: "machine learning",
        context: {
          userGoal: "build practical ML intuition",
          currentKnowledge: "beginner",
        },
        preferences: {
          level: "beginner",
          preferredStyle: "visual examples",
        },
        modules: [{
          title: "Foundations",
          lessons: [{ title: "What is Machine Learning?" }],
        }],
      });

      expect(first.courseId).toBe("machine-learning");
      expect(first.status).toBe("active");
      expect(first.modules[0]?.lessons[0]?.status).toBe("planned");
      expect(first.modules[0]?.lessons[0]?.htmlPath).toBeUndefined();
      expect(existsSync(join(dataDir, "learning", "courses", first.courseId, "course.json"))).toBe(true);
      expect(existsSync(join(dataDir, "learning", "courses", first.courseId, "context.json"))).toBe(true);

      const second = await store.createCourse({
        clientId: "local",
        title: "Automobile Engineering",
        topic: "automobile engineering",
      });

      expect(second.status).toBe("active");
      const pausedFirst = await store.getCourse(first.courseId, "local");
      expect(pausedFirst.status).toBe("paused");

      const active = await store.getActiveCourse("local");
      expect(active?.courseId).toBe(second.courseId);
      const courses = await store.listCourses("local");
      expect(courses.map((course) => course.courseId)).toEqual(expect.arrayContaining([second.courseId, first.courseId]));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("generates one lesson page at a time and advances progress", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new CourseStore({ dataDir });
      const course = await store.createCourse({
        clientId: "local",
        title: "Machine Learning",
        topic: "machine learning",
        modules: [{
          title: "Foundations",
          lessons: [
            { title: "What is Machine Learning?", objectives: ["Define learning from data"] },
            { title: "Regression Basics" },
          ],
        }],
      });

      const generated = await store.generateLessonPage({
        clientId: "local",
        html: "<main><h1>What is Machine Learning?</h1></main>",
        css: "body { font-family: sans-serif; }",
        js: "console.log('lesson loaded');",
        assets: [{
          fileName: "ml-flow.svg",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
        }],
      });

      expect(generated.lesson.status).toBe("generated");
      expect(generated.lesson.htmlPath).toBe("lessons/01-01-what-is-machine-learning.html");
      expect(existsSync(generated.files.htmlPath)).toBe(true);
      expect(existsSync(generated.files.cssPath ?? "")).toBe(true);
      expect(existsSync(generated.files.jsPath ?? "")).toBe(true);
      expect(generated.files.assetPaths[0]).toContain("assets/ml-flow.svg");

      const html = readFileSync(generated.files.htmlPath, "utf8");
      expect(html).toContain("../assets/01-01-what-is-machine-learning.css");
      expect(html).toContain("../assets/01-01-what-is-machine-learning.js");

      const done = await store.markLessonDone({
        clientId: "local",
        courseId: course.courseId,
        lessonId: generated.lesson.id,
      });

      expect(done.progress.completedLessonIds).toContain(generated.lesson.id);
      expect(done.progress.activeLessonId).toBe("01-02-regression-basics");
      expect(done.modules[0]?.lessons[0]?.status).toBe("completed");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("merges gathered context and course notes", async () => {
    const dataDir = makeTmpDir();
    try {
      const store = new CourseStore({ dataDir });
      const course = await store.createCourse({
        clientId: "local",
        title: "Systems Design",
        topic: "systems design",
        context: {
          constraints: ["weekend study"],
        },
      });

      const updated = await store.updateCourseContext({
        clientId: "local",
        courseId: course.courseId,
        preferences: {
          pace: "slow",
        },
        context: {
          constraints: ["weekend study", "project based"],
          notes: ["prefers diagrams"],
        },
      });

      expect(updated.preferences.pace).toBe("slow");
      expect(updated.context.constraints).toEqual(["weekend study", "project based"]);
      expect(updated.context.notes).toEqual(["prefers diagrams"]);

      const withNote = await store.addCourseNote({
        clientId: "local",
        courseId: course.courseId,
        text: "Use backend examples.",
      });
      expect(withNote.notes).toHaveLength(1);
      expect(withNote.notes[0]?.text).toBe("Use backend examples.");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
