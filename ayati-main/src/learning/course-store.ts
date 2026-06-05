import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  ActiveCourseState,
  CourseAssetInput,
  CourseContext,
  CourseFileSummary,
  CourseLesson,
  CourseModule,
  CourseNote,
  CourseProgress,
  GeneratedContentRecord,
  LearningCourse,
  LearningPreferences,
} from "./types.js";

export interface CourseLessonInput {
  id?: string;
  title: string;
  summary?: string;
  objectives?: string[];
}

export interface CourseModuleInput {
  id?: string;
  title: string;
  summary?: string;
  lessons?: CourseLessonInput[];
}

export interface CreateCourseInput {
  clientId: string;
  title: string;
  topic: string;
  courseId?: string;
  description?: string;
  preferences?: LearningPreferences;
  context?: CourseContext;
  modules?: CourseModuleInput[];
  activate?: boolean;
}

export interface UpdateCourseContextInput {
  clientId: string;
  courseId?: string;
  preferences?: LearningPreferences;
  context?: CourseContext;
  description?: string;
}

export interface GenerateLessonPageInput {
  clientId: string;
  courseId?: string;
  moduleId?: string;
  lessonId?: string;
  title?: string;
  summary?: string;
  objectives?: string[];
  html: string;
  css?: string;
  js?: string;
  assets?: CourseAssetInput[];
}

export interface MarkLessonDoneInput {
  clientId: string;
  courseId?: string;
  lessonId?: string;
}

export interface AddCourseNoteInput {
  clientId: string;
  courseId?: string;
  lessonId?: string;
  text: string;
}

export interface CourseStoreOptions {
  dataDir: string;
  now?: () => Date;
}

export interface GeneratedLessonResult {
  course: LearningCourse;
  lesson: CourseLesson;
  files: {
    htmlPath: string;
    cssPath?: string;
    jsPath?: string;
    assetPaths: string[];
  };
}

export class CourseStore {
  readonly learningDir: string;
  readonly coursesDir: string;
  readonly usersDir: string;

  private readonly nowProvider: () => Date;

  constructor(options: CourseStoreOptions) {
    this.learningDir = resolve(options.dataDir, "learning");
    this.coursesDir = resolve(this.learningDir, "courses");
    this.usersDir = resolve(this.learningDir, "users");
    this.nowProvider = options.now ?? (() => new Date());
  }

  async createCourse(input: CreateCourseInput): Promise<LearningCourse> {
    const clientId = normalizeClientId(input.clientId);
    const title = requireNonEmptyString(input.title, "title");
    const topic = requireNonEmptyString(input.topic, "topic");
    const now = this.nowIso();
    const courseId = await this.allocateCourseId(input.courseId ?? title);
    const modules = normalizeModules(input.modules);
    const course: LearningCourse = {
      schemaVersion: 1,
      courseId,
      clientId,
      title,
      topic,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      status: "paused",
      preferences: normalizePreferences(input.preferences),
      context: normalizeContext(input.context),
      modules,
      progress: {
        activeLessonId: firstLessonId(modules),
        completedLessonIds: [],
      },
      generatedContentHistory: [],
      notes: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.writeCourse(course);
    await this.writeCourseContext(course);

    if (input.activate !== false) {
      return this.activateCourse(clientId, courseId);
    }

    return course;
  }

  async listCourses(clientId: string, options?: { includeArchived?: boolean }): Promise<LearningCourse[]> {
    await this.ensureBaseDirs();
    const normalizedClientId = normalizeClientId(clientId);
    const entries = await readdir(this.coursesDir, { withFileTypes: true });
    const courses: LearningCourse[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      try {
        const course = await this.readCourse(entry.name);
        if (course.clientId !== normalizedClientId) {
          continue;
        }
        if (!options?.includeArchived && course.status === "archived") {
          continue;
        }
        courses.push(course);
      } catch {
        continue;
      }
    }

    return courses.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getCourse(courseId: string, clientId?: string): Promise<LearningCourse> {
    const course = await this.readCourse(courseId);
    if (clientId && course.clientId !== normalizeClientId(clientId)) {
      throw new Error(`Course "${courseId}" does not belong to client "${clientId}".`);
    }
    return course;
  }

  async activateCourse(clientId: string, courseId: string): Promise<LearningCourse> {
    const normalizedClientId = normalizeClientId(clientId);
    const normalizedCourseId = normalizeIdentifier(courseId, "courseId");
    const course = await this.getCourse(normalizedCourseId, normalizedClientId);
    const activeState = await this.getActiveCourseState(normalizedClientId);
    const previousCourseId = activeState.activeCourseId;

    if (previousCourseId && previousCourseId !== normalizedCourseId) {
      await this.updateCourseIfExists(previousCourseId, normalizedClientId, (previous) => ({
        ...previous,
        status: previous.status === "archived" ? "archived" : "paused",
        updatedAt: this.nowIso(),
      }));
    }

    const now = this.nowIso();
    const updatedCourse = {
      ...course,
      status: "active" as const,
      progress: {
        ...course.progress,
        lastAccessedAt: now,
      },
      updatedAt: now,
    };
    await this.writeCourse(updatedCourse);
    await this.writeActiveCourseState({
      schemaVersion: 1,
      clientId: normalizedClientId,
      activeCourseId: normalizedCourseId,
      updatedAt: now,
    });
    return updatedCourse;
  }

  async getActiveCourse(clientId: string): Promise<LearningCourse | null> {
    const state = await this.getActiveCourseState(clientId);
    if (!state.activeCourseId) {
      return null;
    }

    try {
      return await this.getCourse(state.activeCourseId, clientId);
    } catch {
      return null;
    }
  }

  async getActiveCourseState(clientId: string): Promise<ActiveCourseState> {
    const normalizedClientId = normalizeClientId(clientId);
    await mkdir(this.usersDir, { recursive: true });
    const statePath = this.activeStatePath(normalizedClientId);
    try {
      return normalizeActiveCourseState(JSON.parse(await readFile(statePath, "utf8")), normalizedClientId);
    } catch {
      return {
        schemaVersion: 1,
        clientId: normalizedClientId,
        updatedAt: this.nowIso(),
      };
    }
  }

  async updateCourseContext(input: UpdateCourseContextInput): Promise<LearningCourse> {
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    const now = this.nowIso();
    const updated: LearningCourse = {
      ...course,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      preferences: {
        ...course.preferences,
        ...normalizePreferences(input.preferences),
      },
      context: mergeCourseContext(course.context, input.context),
      updatedAt: now,
    };
    await this.writeCourse(updated);
    await this.writeCourseContext(updated);
    return updated;
  }

  async generateLessonPage(input: GenerateLessonPageInput): Promise<GeneratedLessonResult> {
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    const html = requireNonEmptyString(input.html, "html");
    const now = this.nowIso();
    const target = resolveTargetLesson(course, {
      moduleId: input.moduleId,
      lessonId: input.lessonId,
      title: input.title,
      summary: input.summary,
      objectives: input.objectives,
    });
    const lesson = target.lesson;
    const courseDir = this.courseDir(course.courseId);
    const lessonsDir = join(courseDir, "lessons");
    const assetsDir = join(courseDir, "assets");
    await mkdir(lessonsDir, { recursive: true });
    await mkdir(assetsDir, { recursive: true });

    const htmlRelativePath = join("lessons", `${lesson.id}.html`);
    const htmlPath = this.resolveCourseFilePath(course.courseId, htmlRelativePath);
    let cssRelativePath: string | undefined;
    let jsRelativePath: string | undefined;

    if (input.css?.trim()) {
      cssRelativePath = join("assets", `${lesson.id}.css`);
      await writeFile(this.resolveCourseFilePath(course.courseId, cssRelativePath), input.css, "utf8");
    }

    if (input.js?.trim()) {
      jsRelativePath = join("assets", `${lesson.id}.js`);
      await writeFile(this.resolveCourseFilePath(course.courseId, jsRelativePath), input.js, "utf8");
    }

    const assetPaths: string[] = [];
    for (const asset of input.assets ?? []) {
      const assetRelativePath = join("assets", normalizeAssetFileName(asset.fileName));
      const assetPath = this.resolveCourseFilePath(course.courseId, assetRelativePath);
      await mkdir(dirname(assetPath), { recursive: true });
      if (asset.encoding === "base64") {
        await writeFile(assetPath, Buffer.from(asset.content, "base64"));
      } else {
        await writeFile(assetPath, asset.content, "utf8");
      }
      assetPaths.push(toPortablePath(assetRelativePath));
    }

    await writeFile(htmlPath, buildLessonHtml({
      title: lesson.title,
      html,
      cssPath: cssRelativePath ? toPortablePath(relativeFrom(htmlRelativePath, cssRelativePath)) : undefined,
      jsPath: jsRelativePath ? toPortablePath(relativeFrom(htmlRelativePath, jsRelativePath)) : undefined,
    }), "utf8");

    lesson.status = "generated";
    lesson.title = input.title?.trim() || lesson.title;
    lesson.summary = input.summary?.trim() || lesson.summary;
    lesson.objectives = normalizeStringArray(input.objectives, lesson.objectives);
    lesson.htmlPath = toPortablePath(htmlRelativePath);
    lesson.cssPath = cssRelativePath ? toPortablePath(cssRelativePath) : lesson.cssPath;
    lesson.jsPath = jsRelativePath ? toPortablePath(jsRelativePath) : lesson.jsPath;
    lesson.assetPaths = [...new Set([...lesson.assetPaths, ...assetPaths])];
    lesson.generatedAt = now;

    const generatedRecord: GeneratedContentRecord = {
      lessonId: lesson.id,
      title: lesson.title,
      htmlPath: lesson.htmlPath,
      ...(lesson.cssPath ? { cssPath: lesson.cssPath } : {}),
      ...(lesson.jsPath ? { jsPath: lesson.jsPath } : {}),
      assetPaths: [...lesson.assetPaths],
      generatedAt: now,
      ...(lesson.summary ? { summary: lesson.summary } : {}),
    };
    const updatedCourse: LearningCourse = {
      ...course,
      modules: target.modules,
      progress: {
        ...course.progress,
        activeLessonId: lesson.id,
        lastAccessedAt: now,
      },
      generatedContentHistory: [
        ...course.generatedContentHistory.filter((entry) => entry.lessonId !== lesson.id),
        generatedRecord,
      ],
      updatedAt: now,
    };
    await this.writeCourse(updatedCourse);

    return {
      course: updatedCourse,
      lesson,
      files: {
        htmlPath,
        ...(cssRelativePath ? { cssPath: this.resolveCourseFilePath(course.courseId, cssRelativePath) } : {}),
        ...(jsRelativePath ? { jsPath: this.resolveCourseFilePath(course.courseId, jsRelativePath) } : {}),
        assetPaths: assetPaths.map((assetPath) => this.resolveCourseFilePath(course.courseId, assetPath)),
      },
    };
  }

  async markLessonDone(input: MarkLessonDoneInput): Promise<LearningCourse> {
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    const lessonId = input.lessonId?.trim() || course.progress.activeLessonId;
    if (!lessonId) {
      throw new Error("No active lesson is available. Provide lessonId.");
    }

    const found = findLesson(course.modules, lessonId);
    if (!found) {
      throw new Error(`Lesson "${lessonId}" was not found in course "${course.courseId}".`);
    }

    const now = this.nowIso();
    found.lesson.status = "completed";
    found.lesson.completedAt = now;
    const completedLessonIds = [...new Set([...course.progress.completedLessonIds, found.lesson.id])];
    const nextLesson = findNextOpenLesson(course.modules, found.lesson.id);
    const progress: CourseProgress = {
      activeLessonId: nextLesson?.id ?? found.lesson.id,
      completedLessonIds,
      lastAccessedAt: now,
    };
    const updated: LearningCourse = {
      ...course,
      modules: found.modules,
      progress,
      updatedAt: now,
    };
    await this.writeCourse(updated);
    return updated;
  }

  async addCourseNote(input: AddCourseNoteInput): Promise<LearningCourse> {
    const text = requireNonEmptyString(input.text, "text");
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    if (input.lessonId?.trim() && !findLesson(course.modules, input.lessonId.trim())) {
      throw new Error(`Lesson "${input.lessonId.trim()}" was not found in course "${course.courseId}".`);
    }

    const now = this.nowIso();
    const note: CourseNote = {
      noteId: `note_${randomBytes(6).toString("hex")}`,
      text,
      ...(input.lessonId?.trim() ? { lessonId: input.lessonId.trim() } : {}),
      createdAt: now,
    };
    const updated: LearningCourse = {
      ...course,
      notes: [...course.notes, note],
      updatedAt: now,
    };
    await this.writeCourse(updated);
    return updated;
  }

  courseFileSummary(courseId: string): CourseFileSummary {
    const normalizedCourseId = normalizeIdentifier(courseId, "courseId");
    const rootPath = this.courseDir(normalizedCourseId);
    return {
      courseId: normalizedCourseId,
      rootPath,
      manifestPath: join(rootPath, "course.json"),
      contextPath: join(rootPath, "context.json"),
      lessonsDir: join(rootPath, "lessons"),
      assetsDir: join(rootPath, "assets"),
    };
  }

  private async resolveCourseForInput(clientId: string, courseId?: string): Promise<LearningCourse> {
    if (courseId?.trim()) {
      return this.getCourse(courseId.trim(), clientId);
    }

    const active = await this.getActiveCourse(clientId);
    if (!active) {
      throw new Error("No active course is selected. Activate or create a course first.");
    }
    return active;
  }

  private async updateCourseIfExists(
    courseId: string,
    clientId: string,
    updater: (course: LearningCourse) => LearningCourse,
  ): Promise<void> {
    try {
      const course = await this.getCourse(courseId, clientId);
      await this.writeCourse(updater(course));
    } catch {
      return;
    }
  }

  private async allocateCourseId(seed: string): Promise<string> {
    await this.ensureBaseDirs();
    const base = slugify(seed) || `course-${randomBytes(4).toString("hex")}`;
    let candidate = base;
    let suffix = 2;
    while (existsSync(this.courseDir(candidate))) {
      candidate = `${base}-${suffix}`;
      suffix++;
    }
    return candidate;
  }

  private async readCourse(courseId: string): Promise<LearningCourse> {
    const normalizedCourseId = normalizeIdentifier(courseId, "courseId");
    const raw = JSON.parse(await readFile(this.coursePath(normalizedCourseId), "utf8")) as unknown;
    return normalizeCourse(raw, normalizedCourseId);
  }

  private async writeCourse(course: LearningCourse): Promise<void> {
    const courseDir = this.courseDir(course.courseId);
    await mkdir(courseDir, { recursive: true });
    await mkdir(join(courseDir, "lessons"), { recursive: true });
    await mkdir(join(courseDir, "assets"), { recursive: true });
    await writeJsonAtomic(this.coursePath(course.courseId), course);
  }

  private async writeCourseContext(course: LearningCourse): Promise<void> {
    await mkdir(this.courseDir(course.courseId), { recursive: true });
    await writeJsonAtomic(join(this.courseDir(course.courseId), "context.json"), {
      schemaVersion: 1,
      courseId: course.courseId,
      clientId: course.clientId,
      topic: course.topic,
      preferences: course.preferences,
      context: course.context,
      updatedAt: course.updatedAt,
    });
  }

  private async writeActiveCourseState(state: ActiveCourseState): Promise<void> {
    await mkdir(this.usersDir, { recursive: true });
    await writeJsonAtomic(this.activeStatePath(state.clientId), state);
  }

  private async ensureBaseDirs(): Promise<void> {
    await mkdir(this.coursesDir, { recursive: true });
    await mkdir(this.usersDir, { recursive: true });
  }

  private courseDir(courseId: string): string {
    return resolve(this.coursesDir, normalizeIdentifier(courseId, "courseId"));
  }

  private coursePath(courseId: string): string {
    return join(this.courseDir(courseId), "course.json");
  }

  private activeStatePath(clientId: string): string {
    return join(this.usersDir, `${normalizeClientId(clientId)}.json`);
  }

  private resolveCourseFilePath(courseId: string, relativePath: string): string {
    const normalizedCourseId = normalizeIdentifier(courseId, "courseId");
    if (isAbsolute(relativePath)) {
      throw new Error("Course file path must be relative.");
    }

    const root = this.courseDir(normalizedCourseId);
    const resolved = resolve(root, relativePath);
    if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
      throw new Error("Course file path escapes the course directory.");
    }
    return resolved;
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function normalizeCourse(raw: unknown, expectedCourseId: string): LearningCourse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid course manifest for "${expectedCourseId}".`);
  }
  const record = raw as Record<string, unknown>;
  const courseId = normalizeIdentifier(String(record["courseId"] ?? expectedCourseId), "courseId");
  const clientId = normalizeClientId(String(record["clientId"] ?? "local"));
  return {
    schemaVersion: 1,
    courseId,
    clientId,
    title: typeof record["title"] === "string" ? record["title"] : courseId,
    topic: typeof record["topic"] === "string" ? record["topic"] : courseId,
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
    status: normalizeCourseStatus(record["status"]),
    preferences: normalizePreferences(record["preferences"]),
    context: normalizeContext(record["context"]),
    modules: normalizeModules(record["modules"]),
    progress: normalizeProgress(record["progress"]),
    generatedContentHistory: normalizeGeneratedHistory(record["generatedContentHistory"]),
    notes: normalizeNotes(record["notes"]),
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : new Date(0).toISOString(),
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : new Date(0).toISOString(),
  };
}

function normalizeCourseStatus(value: unknown): LearningCourse["status"] {
  return value === "active" || value === "archived" || value === "paused" ? value : "paused";
}

function normalizeActiveCourseState(raw: unknown, clientId: string): ActiveCourseState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid active course state.");
  }
  const record = raw as Record<string, unknown>;
  const activeCourseId = typeof record["activeCourseId"] === "string" && record["activeCourseId"].trim().length > 0
    ? normalizeIdentifier(record["activeCourseId"], "activeCourseId")
    : undefined;
  return {
    schemaVersion: 1,
    clientId,
    ...(activeCourseId ? { activeCourseId } : {}),
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : new Date(0).toISOString(),
  };
}

function normalizeModules(raw: unknown): CourseModule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return [{
      id: "module-1",
      title: "Course Setup",
      summary: "Course metadata and future lesson planning.",
      lessons: [],
    }];
  }

  return raw.flatMap((entry, moduleIndex) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const title = typeof record["title"] === "string" && record["title"].trim().length > 0
      ? record["title"].trim()
      : `Module ${moduleIndex + 1}`;
    const moduleId = typeof record["id"] === "string" && record["id"].trim().length > 0
      ? normalizeIdentifier(record["id"], "moduleId")
      : uniqueSlug(title, moduleIndex + 1);
    const lessons = normalizeLessons(record["lessons"], moduleIndex);
    return [{
      id: moduleId,
      title,
      ...(typeof record["summary"] === "string" && record["summary"].trim() ? { summary: record["summary"].trim() } : {}),
      lessons,
    }];
  });
}

function normalizeLessons(raw: unknown, moduleIndex: number): CourseLesson[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.flatMap((entry, lessonIndex) => {
    if (!entry || typeof entry !== "object") {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        return [];
      }
      return [createPlannedLesson(entry.trim(), moduleIndex, lessonIndex)];
    }

    const record = entry as Record<string, unknown>;
    const title = typeof record["title"] === "string" && record["title"].trim().length > 0
      ? record["title"].trim()
      : `Lesson ${lessonIndex + 1}`;
    const lesson = createPlannedLesson(title, moduleIndex, lessonIndex, record);
    return [lesson];
  });
}

function createPlannedLesson(
  title: string,
  moduleIndex: number,
  lessonIndex: number,
  record?: Record<string, unknown>,
): CourseLesson {
  const id = typeof record?.["id"] === "string" && record["id"].trim().length > 0
    ? normalizeIdentifier(record["id"], "lessonId")
    : `${String(moduleIndex + 1).padStart(2, "0")}-${String(lessonIndex + 1).padStart(2, "0")}-${slugify(title)}`;
  const rawAssetPaths = Array.isArray(record?.["assetPaths"]) ? record?.["assetPaths"] : [];
  const assetPaths = rawAssetPaths.flatMap((value) => typeof value === "string" ? [toPortablePath(value)] : []);
  return {
    id,
    title,
    status: normalizeLessonStatus(record?.["status"]),
    ...(typeof record?.["summary"] === "string" && record["summary"].trim() ? { summary: record["summary"].trim() } : {}),
    objectives: normalizeStringArray(record?.["objectives"], []),
    ...(typeof record?.["htmlPath"] === "string" ? { htmlPath: toPortablePath(record["htmlPath"]) } : {}),
    ...(typeof record?.["cssPath"] === "string" ? { cssPath: toPortablePath(record["cssPath"]) } : {}),
    ...(typeof record?.["jsPath"] === "string" ? { jsPath: toPortablePath(record["jsPath"]) } : {}),
    assetPaths,
    ...(typeof record?.["generatedAt"] === "string" ? { generatedAt: record["generatedAt"] } : {}),
    ...(typeof record?.["completedAt"] === "string" ? { completedAt: record["completedAt"] } : {}),
  };
}

function normalizeLessonStatus(value: unknown): CourseLesson["status"] {
  return value === "generated" || value === "completed" || value === "planned" ? value : "planned";
}

function normalizeProgress(raw: unknown): CourseProgress {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { completedLessonIds: [] };
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["activeLessonId"] === "string" && record["activeLessonId"].trim()
      ? { activeLessonId: record["activeLessonId"].trim() }
      : {}),
    completedLessonIds: normalizeStringArray(record["completedLessonIds"], []),
    ...(typeof record["lastAccessedAt"] === "string" ? { lastAccessedAt: record["lastAccessedAt"] } : {}),
  };
}

function normalizeGeneratedHistory(raw: unknown): GeneratedContentRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["lessonId"] !== "string" || typeof record["htmlPath"] !== "string") {
      return [];
    }
    return [{
      lessonId: record["lessonId"],
      title: typeof record["title"] === "string" ? record["title"] : record["lessonId"],
      htmlPath: toPortablePath(record["htmlPath"]),
      ...(typeof record["cssPath"] === "string" ? { cssPath: toPortablePath(record["cssPath"]) } : {}),
      ...(typeof record["jsPath"] === "string" ? { jsPath: toPortablePath(record["jsPath"]) } : {}),
      assetPaths: normalizeStringArray(record["assetPaths"], []).map(toPortablePath),
      generatedAt: typeof record["generatedAt"] === "string" ? record["generatedAt"] : new Date(0).toISOString(),
      ...(typeof record["summary"] === "string" ? { summary: record["summary"] } : {}),
    }];
  });
}

function normalizeNotes(raw: unknown): CourseNote[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (typeof record["text"] !== "string") {
      return [];
    }
    return [{
      noteId: typeof record["noteId"] === "string" ? record["noteId"] : `note_${randomBytes(6).toString("hex")}`,
      text: record["text"],
      ...(typeof record["lessonId"] === "string" ? { lessonId: record["lessonId"] } : {}),
      createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : new Date(0).toISOString(),
    }];
  });
}

function normalizePreferences(raw: unknown): LearningPreferences {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["level"] === "string" && record["level"].trim() ? { level: record["level"].trim() } : {}),
    ...(typeof record["preferredStyle"] === "string" && record["preferredStyle"].trim() ? { preferredStyle: record["preferredStyle"].trim() } : {}),
    ...(typeof record["pace"] === "string" && record["pace"].trim() ? { pace: record["pace"].trim() } : {}),
    ...(typeof record["language"] === "string" && record["language"].trim() ? { language: record["language"].trim() } : {}),
    ...(typeof record["availableTime"] === "string" && record["availableTime"].trim() ? { availableTime: record["availableTime"].trim() } : {}),
    examples: normalizeStringArray(record["examples"], []),
    ...(typeof record["includeProjects"] === "boolean" ? { includeProjects: record["includeProjects"] } : {}),
    ...(typeof record["includeQuizzes"] === "boolean" ? { includeQuizzes: record["includeQuizzes"] } : {}),
    ...(typeof record["notes"] === "string" && record["notes"].trim() ? { notes: record["notes"].trim() } : {}),
  };
}

function normalizeContext(raw: unknown): CourseContext {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["userGoal"] === "string" && record["userGoal"].trim() ? { userGoal: record["userGoal"].trim() } : {}),
    ...(typeof record["currentKnowledge"] === "string" && record["currentKnowledge"].trim() ? { currentKnowledge: record["currentKnowledge"].trim() } : {}),
    ...(typeof record["targetOutcome"] === "string" && record["targetOutcome"].trim() ? { targetOutcome: record["targetOutcome"].trim() } : {}),
    constraints: normalizeStringArray(record["constraints"], []),
    ...(typeof record["sourceSummary"] === "string" && record["sourceSummary"].trim() ? { sourceSummary: record["sourceSummary"].trim() } : {}),
    gatheredQuestions: normalizeStringArray(record["gatheredQuestions"], []),
    gatheredAnswers: normalizeStringArray(record["gatheredAnswers"], []),
    notes: normalizeStringArray(record["notes"], []),
  };
}

function mergeCourseContext(current: CourseContext, next: unknown): CourseContext {
  const normalized = normalizeContext(next);
  return {
    ...current,
    ...normalized,
    constraints: mergeUnique(current.constraints, normalized.constraints),
    gatheredQuestions: mergeUnique(current.gatheredQuestions, normalized.gatheredQuestions),
    gatheredAnswers: mergeUnique(current.gatheredAnswers, normalized.gatheredAnswers),
    notes: mergeUnique(current.notes, normalized.notes),
  };
}

function resolveTargetLesson(
  course: LearningCourse,
  input: {
    moduleId?: string;
    lessonId?: string;
    title?: string;
    summary?: string;
    objectives?: string[];
  },
): { modules: CourseModule[]; lesson: CourseLesson } {
  const modules = cloneModules(course.modules);
  const explicitLessonId = input.lessonId?.trim();
  if (explicitLessonId) {
    const found = findLesson(modules, explicitLessonId);
    if (found) {
      return { modules: found.modules, lesson: found.lesson };
    }
  }

  const nextPlanned = findNextPlannedLesson(modules, input.moduleId);
  if (nextPlanned) {
    return { modules: nextPlanned.modules, lesson: nextPlanned.lesson };
  }

  const title = input.title?.trim();
  if (!title) {
    throw new Error("No planned lesson is available. Provide title to create a new lesson.");
  }

  const module = resolveModuleForNewLesson(modules, input.moduleId);
  const lesson: CourseLesson = {
    id: uniqueLessonId(module, title),
    title,
    ...(input.summary?.trim() ? { summary: input.summary.trim() } : {}),
    status: "planned",
    objectives: normalizeStringArray(input.objectives, []),
    assetPaths: [],
  };
  module.lessons.push(lesson);
  return { modules, lesson };
}

function resolveModuleForNewLesson(modules: CourseModule[], moduleId?: string): CourseModule {
  if (moduleId?.trim()) {
    const normalized = normalizeIdentifier(moduleId, "moduleId");
    const found = modules.find((module) => module.id === normalized);
    if (found) {
      return found;
    }
    const created: CourseModule = {
      id: normalized,
      title: titleFromSlug(normalized),
      lessons: [],
    };
    modules.push(created);
    return created;
  }

  const first = modules[0];
  if (first) {
    return first;
  }

  const created: CourseModule = {
    id: "module-1",
    title: "Course Setup",
    lessons: [],
  };
  modules.push(created);
  return created;
}

function findLesson(modules: CourseModule[], lessonId: string): { modules: CourseModule[]; module: CourseModule; lesson: CourseLesson } | null {
  const normalized = normalizeIdentifier(lessonId, "lessonId");
  for (const module of modules) {
    const lesson = module.lessons.find((candidate) => candidate.id === normalized);
    if (lesson) {
      return { modules, module, lesson };
    }
  }
  return null;
}

function findNextPlannedLesson(
  modules: CourseModule[],
  moduleId?: string,
): { modules: CourseModule[]; module: CourseModule; lesson: CourseLesson } | null {
  const moduleFilter = moduleId?.trim() ? normalizeIdentifier(moduleId, "moduleId") : null;
  for (const module of modules) {
    if (moduleFilter && module.id !== moduleFilter) {
      continue;
    }
    const lesson = module.lessons.find((candidate) => candidate.status === "planned");
    if (lesson) {
      return { modules, module, lesson };
    }
  }
  return null;
}

function findNextOpenLesson(modules: CourseModule[], afterLessonId: string): CourseLesson | null {
  const flattened = modules.flatMap((module) => module.lessons);
  const startIndex = flattened.findIndex((lesson) => lesson.id === afterLessonId);
  const after = flattened.slice(Math.max(0, startIndex + 1)).find((lesson) => lesson.status !== "completed");
  if (after) {
    return after;
  }
  return flattened.find((lesson) => lesson.status !== "completed") ?? null;
}

function cloneModules(modules: CourseModule[]): CourseModule[] {
  return modules.map((module) => ({
    ...module,
    lessons: module.lessons.map((lesson) => ({
      ...lesson,
      objectives: [...lesson.objectives],
      assetPaths: [...lesson.assetPaths],
    })),
  }));
}

function firstLessonId(modules: CourseModule[]): string | undefined {
  return modules.flatMap((module) => module.lessons)[0]?.id;
}

function uniqueLessonId(module: CourseModule, title: string): string {
  const base = slugify(title) || `lesson-${module.lessons.length + 1}`;
  let candidate = base;
  let suffix = 2;
  while (module.lessons.some((lesson) => lesson.id === candidate)) {
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  return candidate;
}

function buildLessonHtml(input: {
  title: string;
  html: string;
  cssPath?: string;
  jsPath?: string;
}): string {
  if (/<html[\s>]/i.test(input.html) || /<!doctype\s+html/i.test(input.html)) {
    return input.html.endsWith("\n") ? input.html : `${input.html}\n`;
  }

  const cssLink = input.cssPath ? `    <link rel="stylesheet" href="${escapeHtmlAttribute(input.cssPath)}">\n` : "";
  const jsScript = input.jsPath ? `    <script src="${escapeHtmlAttribute(input.jsPath)}" defer></script>\n` : "";
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "  <head>",
    "    <meta charset=\"utf-8\">",
    "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `    <title>${escapeHtmlText(input.title)}</title>`,
    cssLink.trimEnd(),
    jsScript.trimEnd(),
    "  </head>",
    "  <body>",
    input.html,
    "  </body>",
    "</html>",
    "",
  ].filter((line) => line.length > 0).join("\n");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

function relativeFrom(fromRelativePath: string, toRelativePath: string): string {
  const fromDir = toPortablePath(dirname(fromRelativePath)).split("/").filter((part) => part.length > 0);
  const target = toPortablePath(toRelativePath).split("/").filter((part) => part.length > 0);
  return [...fromDir.map(() => ".."), ...target].join("/") || ".";
}

function normalizeAssetFileName(fileName: string): string {
  const trimmed = requireNonEmptyString(fileName, "asset.fileName");
  if (isAbsolute(trimmed) || trimmed.includes("\0")) {
    throw new Error("Asset fileName must be a safe relative path.");
  }
  const normalized = toPortablePath(trimmed).split("/").filter((part) => part.length > 0).join("/");
  if (normalized.length === 0 || normalized.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Asset fileName must not escape the assets directory.");
  }
  return normalized;
}

function normalizeIdentifier(value: string, field: string): string {
  const slug = slugify(value);
  if (!slug) {
    throw new Error(`${field} must contain at least one letter or number.`);
  }
  return slug;
}

function normalizeClientId(value: string): string {
  return normalizeIdentifier(value || "local", "clientId");
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function uniqueSlug(value: string, fallbackIndex: number): string {
  return slugify(value) || `item-${fallbackIndex}`;
}

function titleFromSlug(value: string): string {
  return value
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ") || "Module";
}

function normalizeStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) {
    return [...fallback];
  }
  return raw.flatMap((value) => {
    if (typeof value !== "string") {
      return [];
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  });
}

function mergeUnique(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function toPortablePath(value: string): string {
  return value.replace(/\\/g, "/");
}
