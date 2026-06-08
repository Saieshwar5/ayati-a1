import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type {
  ActiveCourseState,
  CourseAssetInput,
  CourseConcept,
  CourseContext,
  CourseFileSummary,
  CourseMap,
  CourseLesson,
  CourseModule,
  CourseNote,
  CourseProgress,
  LearningDoubt,
  GeneratedContentRecord,
  ActiveLearningContext,
  LearnerProfile,
  LearningCourse,
  LearningIndex,
  LessonMetadata,
  LessonMetadataInput,
  LessonPlan,
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
  learnerProfile?: LearnerProfile;
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
  metadata?: LessonMetadataInput;
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

export interface RecordDoubtInput {
  clientId: string;
  courseId?: string;
  lessonId?: string;
  text: string;
  answerSummary?: string;
  conceptIds?: string[];
  status?: LearningDoubt["status"];
}

export interface CourseStoreOptions {
  dataDir: string;
  now?: () => Date;
}

export interface GeneratedLessonResult {
  course: LearningCourse;
  lesson: CourseLesson;
  metadata: LessonMetadata;
  files: {
    htmlPath: string;
    metadataPath: string;
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
      ...(input.learnerProfile ? { learnerProfile: normalizeLearnerProfile(input.learnerProfile) } : {}),
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
    await this.writeCourseMap(createInitialCourseMap(course, now));
    await this.writeLearningIndex(createInitialLearningIndex(course, now));

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
    await this.refreshCourseDirection(updated);
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
    const metadataRelativePath = join("lessons", `${lesson.id}.json`);
    const htmlPath = this.resolveCourseFilePath(course.courseId, htmlRelativePath);
    const metadataPath = this.resolveCourseFilePath(course.courseId, metadataRelativePath);
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

    const metadata = createLessonMetadata({
      course,
      lesson,
      htmlPath: lesson.htmlPath,
      input: input.metadata,
      now,
    });
    await writeJsonAtomic(metadataPath, metadata);

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
    await this.updateCourseMapForLesson(updatedCourse, metadata);
    await this.updateLearningIndexForLesson(updatedCourse, metadata);

    return {
      course: updatedCourse,
      lesson,
      metadata,
      files: {
        htmlPath,
        metadataPath,
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
    await this.updateLearningIndexForCompletion(updated, found.lesson.id);
    await this.updateCourseMapForCompletion(updated, found.lesson.id);
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

  async getCourseMap(courseId: string, clientId?: string): Promise<CourseMap> {
    const course = await this.getCourse(courseId, clientId);
    return this.readCourseMap(course);
  }

  async getLearningIndex(courseId: string, clientId?: string): Promise<LearningIndex> {
    const course = await this.getCourse(courseId, clientId);
    return this.readLearningIndex(course);
  }

  async getActiveLearningContext(clientId: string): Promise<ActiveLearningContext | null> {
    const course = await this.getActiveCourse(clientId);
    if (!course) {
      return null;
    }
    return this.buildActiveLearningContext(course);
  }

  async getActiveLessonMetadata(clientId: string, courseId?: string, lessonId?: string): Promise<LessonMetadata | null> {
    const course = await this.resolveCourseForInput(clientId, courseId);
    const resolvedLessonId = lessonId?.trim() || course.progress.activeLessonId;
    if (!resolvedLessonId) {
      return null;
    }
    return this.readLessonMetadataIfExists(course.courseId, resolvedLessonId);
  }

  async planNextLesson(input: { clientId: string; courseId?: string; focus?: string }): Promise<LessonPlan> {
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    const context = await this.buildActiveLearningContext(course);
    const courseMap = await this.readCourseMap(course);
    const index = await this.readLearningIndex(course);
    const existingLessons = course.modules.flatMap((module) => module.lessons);
    const duplicateWarnings: string[] = [];
    const focus = input.focus?.trim();
    const planned = focus
      ? existingLessons.find((lesson) => sameTopic(lesson.title, focus) || lesson.id === slugify(focus))
      : existingLessons.find((lesson) => lesson.status === "planned");

    if (focus) {
      const alreadyCovered = existingLessons.find((lesson) => {
        if (lesson.status === "planned") {
          return false;
        }
        return sameTopic(lesson.title, focus)
          || lesson.id === slugify(focus)
          || index.learnedConcepts.some((concept) => sameTopic(concept, focus));
      });
      if (alreadyCovered) {
        duplicateWarnings.push(`"${focus}" appears already covered by lesson "${alreadyCovered.title}". Prefer review, practice, or deeper explanation instead of a duplicate core lesson.`);
      }
    }

    const nextConceptId = focus
      ? slugify(focus)
      : courseMap.nextCandidates[0]
        ?? index.nextLikelyTopics[0]
        ?? planned?.title
        ?? "next-first-principles-step";
    const concept = courseMap.concepts.find((candidate) => candidate.id === slugify(nextConceptId) || sameTopic(candidate.title, nextConceptId));
    const title = planned?.title
      ?? titleFromSlug(nextConceptId)
      ?? "Next First-Principles Step";

    return {
      courseId: course.courseId,
      nextLesson: {
        ...(planned?.id ? { lessonId: planned.id } : {}),
        title,
        ...(planned ? findModuleIdForLesson(course.modules, planned.id) : {}),
        reason: duplicateWarnings.length > 0
          ? "The requested focus may overlap existing coverage; use the brief for a review/practice/deeper lesson."
          : "Selected from the active course map, planned outline, and learning index.",
        prerequisites: concept?.prerequisites ?? [],
        conceptsToIntroduce: concept ? [concept.title] : [title],
        conceptsToPractice: index.weakConcepts.slice(0, 3),
      },
      duplicateWarnings,
      wrongDirectionWarnings: courseMap.wrongDirectionWarnings,
      contextCapsule: context,
    };
  }

  async recordDoubt(input: RecordDoubtInput): Promise<{ doubt: LearningDoubt; activeContext: ActiveLearningContext }> {
    const text = requireNonEmptyString(input.text, "text");
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    const lessonId = input.lessonId?.trim() || course.progress.activeLessonId;
    if (lessonId && !findLesson(course.modules, lessonId)) {
      throw new Error(`Lesson "${lessonId}" was not found in course "${course.courseId}".`);
    }

    const now = this.nowIso();
    const doubt: LearningDoubt = {
      doubtId: `doubt_${randomBytes(6).toString("hex")}`,
      courseId: course.courseId,
      ...(lessonId ? { lessonId } : {}),
      text,
      ...(input.answerSummary?.trim() ? { answerSummary: input.answerSummary.trim() } : {}),
      conceptIds: normalizeStringArray(input.conceptIds, []),
      status: input.status === "answered" ? "answered" : "open",
      createdAt: now,
      updatedAt: now,
    };
    const doubts = await this.readDoubts(course.courseId);
    await this.writeDoubts(course.courseId, [...doubts, doubt]);
    await this.updateLearningIndexForDoubt(course, doubt);
    return {
      doubt,
      activeContext: await this.buildActiveLearningContext(course),
    };
  }

  async searchActiveCourseContext(input: { clientId: string; query: string; courseId?: string; limit?: number }): Promise<{
    courseId: string;
    query: string;
    results: Array<{ source: string; title: string; summary: string; score: number }>;
  }> {
    const query = requireNonEmptyString(input.query, "query");
    const course = await this.resolveCourseForInput(input.clientId, input.courseId);
    const haystack = await this.buildSearchHaystack(course);
    const terms = tokenizeSearch(query);
    const results = haystack
      .map((entry) => ({ ...entry, score: scoreSearchEntry(entry, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(20, input.limit ?? 8)));
    return {
      courseId: course.courseId,
      query,
      results,
    };
  }

  courseFileSummary(courseId: string): CourseFileSummary {
    const normalizedCourseId = normalizeIdentifier(courseId, "courseId");
    const rootPath = this.courseDir(normalizedCourseId);
    return {
      courseId: normalizedCourseId,
      rootPath,
      manifestPath: join(rootPath, "course.json"),
      contextPath: join(rootPath, "context.json"),
      courseMapPath: join(rootPath, "course-map.json"),
      learningIndexPath: join(rootPath, "learning-index.json"),
      doubtsPath: join(rootPath, "doubts.json"),
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
      ...(course.learnerProfile ? { learnerProfile: course.learnerProfile } : {}),
      preferences: course.preferences,
      context: course.context,
      updatedAt: course.updatedAt,
    });
  }

  private async readCourseMap(course: LearningCourse): Promise<CourseMap> {
    const path = this.courseMapPath(course.courseId);
    try {
      return normalizeCourseMap(JSON.parse(await readFile(path, "utf8")), course);
    } catch {
      const map = createInitialCourseMap(course, this.nowIso());
      await this.writeCourseMap(map);
      return map;
    }
  }

  private async writeCourseMap(courseMap: CourseMap): Promise<void> {
    await writeJsonAtomic(this.courseMapPath(courseMap.courseId), courseMap);
  }

  private async readLearningIndex(course: LearningCourse): Promise<LearningIndex> {
    const path = this.learningIndexPath(course.courseId);
    try {
      return normalizeLearningIndex(JSON.parse(await readFile(path, "utf8")), course);
    } catch {
      const index = createInitialLearningIndex(course, this.nowIso());
      await this.writeLearningIndex(index);
      return index;
    }
  }

  private async writeLearningIndex(index: LearningIndex): Promise<void> {
    await writeJsonAtomic(this.learningIndexPath(index.courseId), index);
  }

  private async readDoubts(courseId: string): Promise<LearningDoubt[]> {
    try {
      return normalizeDoubts(JSON.parse(await readFile(this.doubtsPath(courseId), "utf8")), normalizeIdentifier(courseId, "courseId"));
    } catch {
      return [];
    }
  }

  private async writeDoubts(courseId: string, doubts: LearningDoubt[]): Promise<void> {
    await writeJsonAtomic(this.doubtsPath(courseId), doubts);
  }

  private async readLessonMetadataIfExists(courseId: string, lessonId: string): Promise<LessonMetadata | null> {
    try {
      const normalizedLessonId = normalizeIdentifier(lessonId, "lessonId");
      const metadata = JSON.parse(await readFile(this.resolveCourseFilePath(courseId, join("lessons", `${normalizedLessonId}.json`)), "utf8")) as unknown;
      return normalizeLessonMetadata(metadata, normalizeIdentifier(courseId, "courseId"), normalizedLessonId);
    } catch {
      return null;
    }
  }

  private async buildActiveLearningContext(course: LearningCourse): Promise<ActiveLearningContext> {
    const courseMap = await this.readCourseMap(course);
    const index = await this.readLearningIndex(course);
    const activeLesson = course.progress.activeLessonId
      ? await this.readLessonMetadataIfExists(course.courseId, course.progress.activeLessonId)
      : null;
    return {
      course: {
        courseId: course.courseId,
        title: course.title,
        topic: course.topic,
        ...(course.context.userGoal ? { purpose: course.context.userGoal } : {}),
        ...(course.context.targetOutcome ? { targetOutcome: course.context.targetOutcome } : {}),
        status: course.status,
      },
      ...(course.learnerProfile ? { learnerProfile: course.learnerProfile } : {}),
      preferences: course.preferences,
      ...(index.currentPosition ? { currentPosition: index.currentPosition } : {}),
      learnedConcepts: index.learnedConcepts,
      weakConcepts: index.weakConcepts,
      openQuestions: index.openQuestions,
      nextLikelyTopics: index.nextLikelyTopics,
      ...(activeLesson ? { activeLesson } : {}),
      courseMap: {
        nextCandidates: courseMap.nextCandidates,
        avoidForNow: courseMap.avoidForNow,
        wrongDirectionWarnings: courseMap.wrongDirectionWarnings,
      },
    };
  }

  private async updateCourseMapForLesson(course: LearningCourse, metadata: LessonMetadata): Promise<void> {
    const courseMap = await this.readCourseMap(course);
    const concepts = mergeConceptUpdates(courseMap.concepts, metadata, "introduced", this.nowIso());
    const nextCandidates = mergeUnique(
      metadata.nextSuggestedConcepts.map(slugify),
      courseMap.nextCandidates.filter((candidate) => !metadata.conceptsIntroduced.some((concept) => sameTopic(concept, candidate))),
    );
    const updated: CourseMap = {
      ...courseMap,
      currentPosition: metadata.title,
      concepts,
      nextCandidates,
      avoidForNow: mergeUnique(courseMap.avoidForNow, metadata.avoidRepeating),
      updatedAt: this.nowIso(),
    };
    await this.writeCourseMap(updated);
  }

  private async updateLearningIndexForLesson(course: LearningCourse, metadata: LessonMetadata): Promise<void> {
    const index = await this.readLearningIndex(course);
    const introduced = normalizeStringArray([
      ...metadata.primitiveIdeas,
      ...metadata.firstPrinciples,
      ...metadata.conceptsIntroduced,
    ], []);
    const updated: LearningIndex = {
      ...index,
      learnedConcepts: mergeUnique(index.learnedConcepts, introduced),
      currentPosition: metadata.title,
      nextLikelyTopics: mergeUnique(metadata.nextSuggestedConcepts, index.nextLikelyTopics.filter((topic) => !sameTopic(topic, metadata.title))),
      firstPrinciplesMap: mergeUnique(index.firstPrinciplesMap, metadata.firstPrinciples),
      updatedAt: this.nowIso(),
    };
    await this.writeLearningIndex(updated);
  }

  private async updateLearningIndexForCompletion(course: LearningCourse, lessonId: string): Promise<void> {
    const index = await this.readLearningIndex(course);
    const metadata = await this.readLessonMetadataIfExists(course.courseId, lessonId);
    const learned = metadata
      ? mergeUnique(index.learnedConcepts, [...metadata.conceptsIntroduced, ...metadata.conceptsPracticed])
      : index.learnedConcepts;
    const updated: LearningIndex = {
      ...index,
      learnedConcepts: learned,
      completedLessons: mergeUnique(index.completedLessons, [lessonId]),
      currentPosition: course.progress.activeLessonId
        ? findLesson(course.modules, course.progress.activeLessonId)?.lesson.title ?? index.currentPosition
        : index.currentPosition,
      updatedAt: this.nowIso(),
    };
    await this.writeLearningIndex(updated);
  }

  private async updateCourseMapForCompletion(course: LearningCourse, lessonId: string): Promise<void> {
    const metadata = await this.readLessonMetadataIfExists(course.courseId, lessonId);
    if (!metadata) {
      return;
    }
    const courseMap = await this.readCourseMap(course);
    const completedConceptIds = new Set([...metadata.conceptsIntroduced, ...metadata.conceptsPracticed].map(slugify));
    const concepts = courseMap.concepts.map((concept) => completedConceptIds.has(concept.id)
      ? { ...concept, status: "mastered" as const, updatedAt: this.nowIso() }
      : concept);
    await this.writeCourseMap({
      ...courseMap,
      concepts,
      currentPosition: course.progress.activeLessonId
        ? findLesson(course.modules, course.progress.activeLessonId)?.lesson.title ?? courseMap.currentPosition
        : courseMap.currentPosition,
      updatedAt: this.nowIso(),
    });
  }

  private async updateLearningIndexForDoubt(course: LearningCourse, doubt: LearningDoubt): Promise<void> {
    const index = await this.readLearningIndex(course);
    const weakConcepts = doubt.conceptIds.length > 0
      ? mergeUnique(index.weakConcepts, doubt.conceptIds)
      : index.weakConcepts;
    const openQuestions = doubt.status === "open"
      ? mergeUnique(index.openQuestions, [doubt.text])
      : index.openQuestions;
    await this.writeLearningIndex({
      ...index,
      weakConcepts,
      openQuestions,
      updatedAt: this.nowIso(),
    });
  }

  private async refreshCourseDirection(course: LearningCourse): Promise<void> {
    const courseMap = await this.readCourseMap(course);
    await this.writeCourseMap({
      ...courseMap,
      ...(course.context.userGoal ? { purpose: course.context.userGoal } : {}),
      ...(course.context.targetOutcome ? { targetOutcome: course.context.targetOutcome } : {}),
      updatedAt: this.nowIso(),
    });
  }

  private async buildSearchHaystack(course: LearningCourse): Promise<Array<{ source: string; title: string; summary: string }>> {
    const courseMap = await this.readCourseMap(course);
    const index = await this.readLearningIndex(course);
    const doubts = await this.readDoubts(course.courseId);
    const lessonEntries: Array<{ source: string; title: string; summary: string }> = [];
    for (const lesson of course.modules.flatMap((module) => module.lessons)) {
      const metadata = await this.readLessonMetadataIfExists(course.courseId, lesson.id);
      lessonEntries.push({
        source: `lesson:${lesson.id}`,
        title: lesson.title,
        summary: [
          lesson.summary,
          metadata?.summaryForAgent,
          ...(metadata?.firstPrinciples ?? []),
          ...(metadata?.conceptsIntroduced ?? []),
          ...(metadata?.examplesUsed ?? []),
        ].filter(Boolean).join("\n"),
      });
    }
    return [
      {
        source: "course",
        title: course.title,
        summary: [
          course.topic,
          course.description,
          course.context.userGoal,
          course.context.currentKnowledge,
          course.context.targetOutcome,
          ...(course.context.notes ?? []),
        ].filter(Boolean).join("\n"),
      },
      {
        source: "course-map",
        title: "Course Map",
        summary: [
          courseMap.currentPosition,
          ...courseMap.nextCandidates,
          ...courseMap.avoidForNow,
          ...courseMap.wrongDirectionWarnings,
          ...courseMap.concepts.map((concept) => `${concept.title}: ${concept.status}; prerequisites=${concept.prerequisites.join(", ")}`),
        ].filter(Boolean).join("\n"),
      },
      {
        source: "learning-index",
        title: "Learning Index",
        summary: [
          index.currentPosition,
          ...index.learnedConcepts,
          ...index.weakConcepts,
          ...index.openQuestions,
          ...index.nextLikelyTopics,
          ...index.firstPrinciplesMap,
        ].filter(Boolean).join("\n"),
      },
      ...lessonEntries,
      ...course.notes.map((note) => ({
        source: `note:${note.noteId}`,
        title: note.lessonId ? `Note for ${note.lessonId}` : "Course Note",
        summary: note.text,
      })),
      ...doubts.map((doubt) => ({
        source: `doubt:${doubt.doubtId}`,
        title: doubt.lessonId ? `Doubt for ${doubt.lessonId}` : "Course Doubt",
        summary: [doubt.text, doubt.answerSummary, ...doubt.conceptIds].filter(Boolean).join("\n"),
      })),
    ];
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

  private courseMapPath(courseId: string): string {
    return join(this.courseDir(courseId), "course-map.json");
  }

  private learningIndexPath(courseId: string): string {
    return join(this.courseDir(courseId), "learning-index.json");
  }

  private doubtsPath(courseId: string): string {
    return join(this.courseDir(courseId), "doubts.json");
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
    ...(record["learnerProfile"] ? { learnerProfile: normalizeLearnerProfile(record["learnerProfile"]) } : {}),
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

function createInitialCourseMap(course: LearningCourse, now: string): CourseMap {
  const plannedConcepts = course.modules.flatMap((module) => module.lessons.map((lesson) => ({
    id: slugify(lesson.title) || lesson.id,
    title: lesson.title,
    status: lesson.status === "planned" ? "planned" as const : "introduced" as const,
    lessonIds: [lesson.id],
    prerequisites: [],
    notes: lesson.summary ? [lesson.summary] : [],
    updatedAt: now,
  })));
  return {
    schemaVersion: 1,
    courseId: course.courseId,
    ...(course.context.userGoal ? { purpose: course.context.userGoal } : {}),
    ...(course.context.targetOutcome ? { targetOutcome: course.context.targetOutcome } : {}),
    currentPosition: course.progress.activeLessonId
      ? findLesson(course.modules, course.progress.activeLessonId)?.lesson.title
      : undefined,
    concepts: dedupeConcepts(plannedConcepts),
    nextCandidates: course.modules
      .flatMap((module) => module.lessons)
      .filter((lesson) => lesson.status === "planned")
      .slice(0, 5)
      .map((lesson) => slugify(lesson.title) || lesson.id),
    avoidForNow: [],
    wrongDirectionWarnings: [
      "Do not generate duplicate core lessons. If a concept is already introduced or mastered, use review, practice, or deeper explanation instead.",
      "Do not jump to advanced topics before prerequisites in the active course map are satisfied.",
    ],
    updatedAt: now,
  };
}

function createInitialLearningIndex(course: LearningCourse, now: string): LearningIndex {
  const completedLessons = course.progress.completedLessonIds;
  const generatedLessons = course.modules.flatMap((module) => module.lessons).filter((lesson) => lesson.status !== "planned");
  return {
    schemaVersion: 1,
    courseId: course.courseId,
    learnedConcepts: generatedLessons.map((lesson) => lesson.title),
    weakConcepts: [],
    openQuestions: [],
    completedLessons,
    currentPosition: course.progress.activeLessonId
      ? findLesson(course.modules, course.progress.activeLessonId)?.lesson.title
      : undefined,
    nextLikelyTopics: course.modules
      .flatMap((module) => module.lessons)
      .filter((lesson) => lesson.status === "planned")
      .slice(0, 5)
      .map((lesson) => lesson.title),
    firstPrinciplesMap: [],
    updatedAt: now,
  };
}

function normalizeCourseMap(raw: unknown, course: LearningCourse): CourseMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createInitialCourseMap(course, course.updatedAt);
  }
  const record = raw as Record<string, unknown>;
  const fallback = createInitialCourseMap(course, course.updatedAt);
  return {
    schemaVersion: 1,
    courseId: normalizeIdentifier(String(record["courseId"] ?? course.courseId), "courseId"),
    ...(typeof record["purpose"] === "string" && record["purpose"].trim() ? { purpose: record["purpose"].trim() } : fallback.purpose ? { purpose: fallback.purpose } : {}),
    ...(typeof record["targetOutcome"] === "string" && record["targetOutcome"].trim() ? { targetOutcome: record["targetOutcome"].trim() } : fallback.targetOutcome ? { targetOutcome: fallback.targetOutcome } : {}),
    ...(typeof record["currentPosition"] === "string" && record["currentPosition"].trim() ? { currentPosition: record["currentPosition"].trim() } : fallback.currentPosition ? { currentPosition: fallback.currentPosition } : {}),
    concepts: normalizeCourseConcepts(record["concepts"], fallback.concepts),
    nextCandidates: normalizeStringArray(record["nextCandidates"], fallback.nextCandidates),
    avoidForNow: normalizeStringArray(record["avoidForNow"], fallback.avoidForNow),
    wrongDirectionWarnings: normalizeStringArray(record["wrongDirectionWarnings"], fallback.wrongDirectionWarnings),
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : fallback.updatedAt,
  };
}

function normalizeLearningIndex(raw: unknown, course: LearningCourse): LearningIndex {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return createInitialLearningIndex(course, course.updatedAt);
  }
  const record = raw as Record<string, unknown>;
  const fallback = createInitialLearningIndex(course, course.updatedAt);
  return {
    schemaVersion: 1,
    courseId: normalizeIdentifier(String(record["courseId"] ?? course.courseId), "courseId"),
    learnedConcepts: normalizeStringArray(record["learnedConcepts"], fallback.learnedConcepts),
    weakConcepts: normalizeStringArray(record["weakConcepts"], fallback.weakConcepts),
    openQuestions: normalizeStringArray(record["openQuestions"], fallback.openQuestions),
    completedLessons: normalizeStringArray(record["completedLessons"], fallback.completedLessons),
    ...(typeof record["currentPosition"] === "string" && record["currentPosition"].trim() ? { currentPosition: record["currentPosition"].trim() } : fallback.currentPosition ? { currentPosition: fallback.currentPosition } : {}),
    nextLikelyTopics: normalizeStringArray(record["nextLikelyTopics"], fallback.nextLikelyTopics),
    firstPrinciplesMap: normalizeStringArray(record["firstPrinciplesMap"], fallback.firstPrinciplesMap),
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : fallback.updatedAt,
  };
}

function normalizeCourseConcepts(raw: unknown, fallback: CourseConcept[]): CourseConcept[] {
  if (!Array.isArray(raw)) {
    return fallback;
  }
  const concepts = raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const title = typeof record["title"] === "string" && record["title"].trim()
      ? record["title"].trim()
      : typeof record["id"] === "string"
        ? titleFromSlug(record["id"])
        : "";
    if (!title) {
      return [];
    }
    const id = typeof record["id"] === "string" && record["id"].trim()
      ? normalizeIdentifier(record["id"], "conceptId")
      : slugify(title);
    return [{
      id,
      title,
      status: normalizeConceptStatus(record["status"]),
      lessonIds: normalizeStringArray(record["lessonIds"], []),
      prerequisites: normalizeStringArray(record["prerequisites"], []),
      notes: normalizeStringArray(record["notes"], []),
      ...(typeof record["updatedAt"] === "string" ? { updatedAt: record["updatedAt"] } : {}),
    }];
  });
  return concepts.length > 0 ? dedupeConcepts(concepts) : fallback;
}

function normalizeConceptStatus(value: unknown): CourseConcept["status"] {
  return value === "unseen"
    || value === "planned"
    || value === "introduced"
    || value === "practiced"
    || value === "mastered"
    || value === "blocked"
    ? value
    : "unseen";
}

function normalizeLearnerProfile(raw: unknown): LearnerProfile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["age"] === "string" && record["age"].trim() ? { age: record["age"].trim() } : {}),
    ...(typeof record["qualification"] === "string" && record["qualification"].trim() ? { qualification: record["qualification"].trim() } : {}),
    ...(typeof record["background"] === "string" && record["background"].trim() ? { background: record["background"].trim() } : {}),
    ...(typeof record["motivation"] === "string" && record["motivation"].trim() ? { motivation: record["motivation"].trim() } : {}),
    knownStrengths: normalizeStringArray(record["knownStrengths"], []),
    knownWeaknesses: normalizeStringArray(record["knownWeaknesses"], []),
  };
}

function createLessonMetadata(input: {
  course: LearningCourse;
  lesson: CourseLesson;
  htmlPath: string;
  input?: LessonMetadataInput;
  now: string;
}): LessonMetadata {
  const source = input.input ?? {};
  const fallbackConcept = input.lesson.title;
  const conceptsIntroduced = normalizeStringArray(source.conceptsIntroduced, [fallbackConcept]);
  const summaryForAgent = typeof source.summaryForAgent === "string" && source.summaryForAgent.trim()
    ? source.summaryForAgent.trim()
    : input.lesson.summary
      ? input.lesson.summary
      : `The user is learning "${input.lesson.title}" in ${input.course.title}.`;
  return {
    schemaVersion: 1,
    courseId: input.course.courseId,
    lessonId: input.lesson.id,
    title: input.lesson.title,
    htmlPath: input.htmlPath,
    ...(typeof source.purpose === "string" && source.purpose.trim() ? { purpose: source.purpose.trim() } : {}),
    primitiveIdeas: normalizeStringArray(source.primitiveIdeas, input.lesson.objectives),
    firstPrinciples: normalizeStringArray(source.firstPrinciples, []),
    conceptsIntroduced,
    conceptsPracticed: normalizeStringArray(source.conceptsPracticed, []),
    prerequisitesUsed: normalizeStringArray(source.prerequisitesUsed, []),
    examplesUsed: normalizeStringArray(source.examplesUsed, []),
    exercises: normalizeLessonExercises(source.exercises),
    visualSections: normalizeLessonVisualSections(source.visualSections),
    commonDoubts: normalizeStringArray(source.commonDoubts, []),
    summaryForAgent,
    nextSuggestedConcepts: normalizeStringArray(source.nextSuggestedConcepts, []),
    avoidRepeating: normalizeStringArray(source.avoidRepeating, [fallbackConcept]),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function normalizeLessonMetadata(raw: unknown, courseId: string, lessonId: string): LessonMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid lesson metadata for "${lessonId}".`);
  }
  const record = raw as Record<string, unknown>;
  const title = typeof record["title"] === "string" && record["title"].trim() ? record["title"].trim() : titleFromSlug(lessonId);
  const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : new Date(0).toISOString();
  return {
    schemaVersion: 1,
    courseId,
    lessonId,
    title,
    ...(typeof record["htmlPath"] === "string" ? { htmlPath: toPortablePath(record["htmlPath"]) } : {}),
    ...(typeof record["purpose"] === "string" && record["purpose"].trim() ? { purpose: record["purpose"].trim() } : {}),
    primitiveIdeas: normalizeStringArray(record["primitiveIdeas"], []),
    firstPrinciples: normalizeStringArray(record["firstPrinciples"], []),
    conceptsIntroduced: normalizeStringArray(record["conceptsIntroduced"], [title]),
    conceptsPracticed: normalizeStringArray(record["conceptsPracticed"], []),
    prerequisitesUsed: normalizeStringArray(record["prerequisitesUsed"], []),
    examplesUsed: normalizeStringArray(record["examplesUsed"], []),
    exercises: normalizeLessonExercises(record["exercises"]),
    visualSections: normalizeLessonVisualSections(record["visualSections"]),
    commonDoubts: normalizeStringArray(record["commonDoubts"], []),
    summaryForAgent: typeof record["summaryForAgent"] === "string" && record["summaryForAgent"].trim()
      ? record["summaryForAgent"].trim()
      : `The user is learning "${title}".`,
    nextSuggestedConcepts: normalizeStringArray(record["nextSuggestedConcepts"], []),
    avoidRepeating: normalizeStringArray(record["avoidRepeating"], [title]),
    createdAt,
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : createdAt,
  };
}

function normalizeLessonExercises(raw: unknown): LessonMetadata["exercises"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const prompt = typeof record["prompt"] === "string" && record["prompt"].trim() ? record["prompt"].trim() : "";
    if (!prompt) {
      return [];
    }
    return [{
      id: typeof record["id"] === "string" && record["id"].trim() ? normalizeIdentifier(record["id"], "exerciseId") : `exercise-${index + 1}`,
      prompt,
      ...(typeof record["expectedInsight"] === "string" && record["expectedInsight"].trim() ? { expectedInsight: record["expectedInsight"].trim() } : {}),
    }];
  });
}

function normalizeLessonVisualSections(raw: unknown): LessonMetadata["visualSections"] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const title = typeof record["title"] === "string" && record["title"].trim() ? record["title"].trim() : "";
    if (!title) {
      return [];
    }
    return [{
      id: typeof record["id"] === "string" && record["id"].trim() ? normalizeIdentifier(record["id"], "visualSectionId") : `section-${index + 1}`,
      title,
      ...(typeof record["summary"] === "string" && record["summary"].trim() ? { summary: record["summary"].trim() } : {}),
      ...(typeof record["htmlAnchor"] === "string" && record["htmlAnchor"].trim() ? { htmlAnchor: record["htmlAnchor"].trim() } : {}),
    }];
  });
}

function normalizeDoubts(raw: unknown, courseId: string): LearningDoubt[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const text = typeof record["text"] === "string" && record["text"].trim() ? record["text"].trim() : "";
    if (!text) {
      return [];
    }
    const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : new Date(0).toISOString();
    return [{
      doubtId: typeof record["doubtId"] === "string" && record["doubtId"].trim() ? record["doubtId"].trim() : `doubt_${randomBytes(6).toString("hex")}`,
      courseId,
      ...(typeof record["lessonId"] === "string" && record["lessonId"].trim() ? { lessonId: normalizeIdentifier(record["lessonId"], "lessonId") } : {}),
      text,
      ...(typeof record["answerSummary"] === "string" && record["answerSummary"].trim() ? { answerSummary: record["answerSummary"].trim() } : {}),
      conceptIds: normalizeStringArray(record["conceptIds"], []),
      status: record["status"] === "answered" ? "answered" : "open",
      createdAt,
      updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : createdAt,
    }];
  });
}

function mergeConceptUpdates(
  concepts: CourseConcept[],
  metadata: LessonMetadata,
  defaultStatus: CourseConcept["status"],
  now: string,
): CourseConcept[] {
  const byId = new Map(concepts.map((concept) => [concept.id, { ...concept }]));
  const upsert = (title: string, status: CourseConcept["status"], prerequisites: string[] = []) => {
    const id = slugify(title);
    if (!id) {
      return;
    }
    const existing = byId.get(id);
    if (existing) {
      byId.set(id, {
        ...existing,
        title: existing.title || title,
        status: strongerConceptStatus(existing.status, status),
        lessonIds: mergeUnique(existing.lessonIds, [metadata.lessonId]),
        prerequisites: mergeUnique(existing.prerequisites, prerequisites),
        updatedAt: now,
      });
      return;
    }
    byId.set(id, {
      id,
      title,
      status,
      lessonIds: [metadata.lessonId],
      prerequisites,
      notes: [],
      updatedAt: now,
    });
  };
  for (const concept of metadata.conceptsIntroduced) {
    upsert(concept, defaultStatus, metadata.prerequisitesUsed);
  }
  for (const concept of metadata.conceptsPracticed) {
    upsert(concept, "practiced", metadata.prerequisitesUsed);
  }
  for (const concept of metadata.nextSuggestedConcepts) {
    upsert(concept, "planned", []);
  }
  return [...byId.values()];
}

function strongerConceptStatus(current: CourseConcept["status"], next: CourseConcept["status"]): CourseConcept["status"] {
  const order: CourseConcept["status"][] = ["unseen", "planned", "introduced", "practiced", "mastered", "blocked"];
  return order.indexOf(next) > order.indexOf(current) ? next : current;
}

function dedupeConcepts(concepts: CourseConcept[]): CourseConcept[] {
  const byId = new Map<string, CourseConcept>();
  for (const concept of concepts) {
    const existing = byId.get(concept.id);
    if (!existing) {
      byId.set(concept.id, concept);
      continue;
    }
    byId.set(concept.id, {
      ...existing,
      status: strongerConceptStatus(existing.status, concept.status),
      lessonIds: mergeUnique(existing.lessonIds, concept.lessonIds),
      prerequisites: mergeUnique(existing.prerequisites, concept.prerequisites),
      notes: mergeUnique(existing.notes, concept.notes),
      updatedAt: concept.updatedAt ?? existing.updatedAt,
    });
  }
  return [...byId.values()];
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

function findModuleIdForLesson(modules: CourseModule[], lessonId: string): { moduleId: string } | undefined {
  const normalized = normalizeIdentifier(lessonId, "lessonId");
  for (const module of modules) {
    if (module.lessons.some((lesson) => lesson.id === normalized)) {
      return { moduleId: module.id };
    }
  }
  return undefined;
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

function sameTopic(a: string, b: string): boolean {
  const left = slugify(a);
  const right = slugify(b);
  if (!left || !right) {
    return false;
  }
  return left === right || left.includes(right) || right.includes(left);
}

function tokenizeSearch(value: string): string[] {
  return [...new Set(value
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 1))];
}

function scoreSearchEntry(entry: { title: string; summary: string }, terms: string[]): number {
  const title = entry.title.toLowerCase();
  const summary = entry.summary.toLowerCase();
  return terms.reduce((score, term) => {
    if (title.includes(term)) {
      score += 4;
    }
    if (summary.includes(term)) {
      score += 1;
    }
    return score;
  }, 0);
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
