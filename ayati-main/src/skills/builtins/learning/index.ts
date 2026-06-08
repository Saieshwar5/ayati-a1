import type { CourseLessonInput, CourseModuleInput, CourseStore } from "../../../learning/course-store.js";
import type {
  CourseAssetInput,
  CourseContext,
  CourseFileSummary,
  CourseLesson,
  LessonMetadataInput,
  LearningCourse,
  LearningPreferences,
} from "../../../learning/types.js";
import type { LearningWorkspaceController } from "../../../ui/learning-workspace.js";
import type { SkillDefinition, ToolDefinition, ToolExecutionContext, ToolResult } from "../../types.js";

export interface LearningSkillDeps {
  courseStore: CourseStore;
  learningWorkspace?: LearningWorkspaceController;
}

const LEARNING_PROMPT_BLOCK = [
  "Learning course tools are built in.",
  "Use learning_start_course_session when the user wants to start learning a new topic. It creates course metadata, generates exactly one first lesson, activates the course, and opens the visual learning workspace when available.",
  "Use learning_create_course only when metadata/outline should be created without lesson content.",
  "Course creation is metadata-first: create course context, preferences, and a planned outline, but do not generate all lesson content up front.",
  "A new course request must generate at most one lesson unless the user explicitly asks to pre-generate multiple lessons.",
  "Do not repeatedly call lesson-generation tools in one run to fill an entire course. Planned lessons should stay planned until the user asks to continue.",
  "Gather enough learning context before creating or expanding a course: goal, level, preferred style, pace, time budget, examples, and target outcome.",
  "Use learning_activate_course when the user switches between courses. Only one course is active for a client at a time.",
  "Use learning_get_active_course before continuing an unspecified course.",
  "Use learning_continue_course when the user asks for the next lesson. It generates exactly one planned lesson, updates progress, and opens the visual workspace when available.",
  "Use learning_generate_lesson_page only for low-level repair or explicit manual lesson writing. Prefer the session tools for normal learning.",
  "Use saved course context, previous generated lessons, notes, and progress to keep future lessons consistent.",
  "Use learning_get_active_learning_context before answering course-specific doubts or deciding what to teach next.",
  "When the user asks a doubt while a learning lesson is active, use learning_get_active_lesson_context first, answer from that lesson's concepts/examples, then call learning_record_doubt when the doubt should affect future lessons.",
  "Use learning_plan_next_lesson before generating a continuation. The planner checks the course map, learning index, duplicate topics, prerequisites, and wrong-direction warnings.",
  "Use learning_search_active_course_context when you need details from prior lessons, notes, doubts, the course map, or the learning index. Do not assume from conversation alone.",
  "Generated lesson HTML is the visual teaching surface. The lesson metadata is the agent-readable source of truth and must summarize primitives, first principles, concepts, examples, exercises, and next suggestions.",
  "Use learning_mark_lesson_done when the user finishes a lesson, and learning_add_course_note for durable course-specific notes.",
].join("\n");

export function createLearningSkill(deps: LearningSkillDeps): SkillDefinition {
  return {
    id: "learning",
    version: "1.0.0",
    description: "Create, activate, continue, and track durable learning courses with generated lesson pages.",
    promptBlock: LEARNING_PROMPT_BLOCK,
    tools: [
      createStartCourseSessionTool(deps),
      createCourseTool(deps),
      createListCoursesTool(deps),
      createActivateCourseTool(deps),
      createGetActiveCourseTool(deps),
      createGetActiveLearningContextTool(deps),
      createGetActiveLessonContextTool(deps),
      createGetCourseTool(deps),
      createUpdateCourseContextTool(deps),
      createPlanNextLessonTool(deps),
      createContinueCourseTool(deps),
      createGenerateLessonPageTool(deps),
      createMarkLessonDoneTool(deps),
      createGetProgressTool(deps),
      createAddCourseNoteTool(deps),
      createRecordDoubtTool(deps),
      createSearchActiveCourseContextTool(deps),
    ],
  };
}

function createStartCourseSessionTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_start_course_session",
    description: "Create a new course, generate exactly one first lesson, activate it, and open the visual learning workspace when available.",
    inputSchema: {
      type: "object",
      required: ["title", "topic", "firstLesson"],
      properties: {
        courseId: { type: "string", description: "Optional stable course id. A slug is generated when omitted." },
        title: { type: "string", description: "Course title." },
        topic: { type: "string", description: "Learning topic." },
        description: { type: "string", description: "Short course description." },
        learnerProfile: learnerProfileSchema(),
        preferences: preferencesSchema(),
        context: contextSchema(),
        modules: modulesSchema(),
        firstLesson: lessonContentSchema({
          description: "The only lesson content to generate at course start.",
          requireHtml: true,
        }),
        openWorkspace: {
          type: "boolean",
          description: "Open the Tauri learning workspace after saving the first lesson. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "session", "start", "tauri", "workspace"],
      domain: "learning",
      priority: 120,
      examples: [
        "Start a course for a user and render only the first lesson.",
        "Create a beginner learning path without generating the full course up front.",
      ],
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const firstLesson = asRecord(value["firstLesson"]);
        const clientId = clientIdFromContext(context);
        const firstLessonTitle = readRequiredString(firstLesson, "title");
        const firstLessonModuleId = readOptionalString(firstLesson, "moduleId");
        const firstLessonLessonId = readOptionalString(firstLesson, "lessonId");
        const modules = ensureFirstLessonInOutline(
          readOptionalArray(value, "modules") as CourseModuleInput[] | undefined,
          {
            lessonId: firstLessonLessonId,
            moduleId: firstLessonModuleId,
            title: firstLessonTitle,
            summary: readOptionalString(firstLesson, "summary"),
            objectives: readOptionalStringArray(firstLesson, "objectives"),
          },
        );

        const course = await deps.courseStore.createCourse({
          clientId,
          title: readRequiredString(value, "title"),
          topic: readRequiredString(value, "topic"),
          courseId: readOptionalString(value, "courseId"),
          description: readOptionalString(value, "description"),
          learnerProfile: readOptionalRecord(value, "learnerProfile") as LearningCourse["learnerProfile"],
          preferences: readOptionalRecord(value, "preferences") as LearningPreferences | undefined,
          context: readOptionalRecord(value, "context") as CourseContext | undefined,
          modules,
          activate: true,
        });

        const generated = await deps.courseStore.generateLessonPage({
          clientId,
          courseId: course.courseId,
          moduleId: firstLessonModuleId,
          lessonId: firstLessonLessonId ?? (firstLessonModuleId ? undefined : course.progress.activeLessonId),
          title: firstLessonTitle,
          summary: readOptionalString(firstLesson, "summary"),
          objectives: readOptionalStringArray(firstLesson, "objectives"),
          html: readRequiredString(firstLesson, "html"),
          css: readOptionalString(firstLesson, "css"),
          js: readOptionalString(firstLesson, "js"),
          assets: readOptionalArray(firstLesson, "assets") as CourseAssetInput[] | undefined,
          metadata: readOptionalRecord(firstLesson, "metadata") as LessonMetadataInput | undefined,
        });

        const workspace = await maybeOpenWorkspace(deps, {
          clientId,
          courseId: generated.course.courseId,
          lessonId: generated.lesson.id,
          shouldOpen: value["openWorkspace"] !== false,
          uiContext: context?.uiContext,
        });

        return {
          policy: {
            generatedLessonCount: 1,
            remainingLessonsStayPlanned: true,
          },
          course: courseSummary(generated.course, deps.courseStore.courseFileSummary(generated.course.courseId)),
          lesson: lessonPayload(generated.lesson),
          metadata: generated.metadata,
          files: generated.files,
          workspace,
        };
      });
    },
  };
}

function createCourseTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_create_course",
    description: "Create a metadata-first learning course with context, preferences, and an optional planned outline. Does not generate lesson pages; use learning_start_course_session for normal new learning sessions.",
    inputSchema: {
      type: "object",
      required: ["title", "topic"],
      properties: {
        courseId: { type: "string", description: "Optional stable course id. A slug is generated when omitted." },
        title: { type: "string", description: "Course title." },
        topic: { type: "string", description: "Learning topic." },
        description: { type: "string", description: "Short course description." },
        learnerProfile: learnerProfileSchema(),
        preferences: preferencesSchema(),
        context: contextSchema(),
        modules: modulesSchema(),
        activate: { type: "boolean", description: "Whether to activate this course immediately. Defaults to true." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "create", "metadata"],
      domain: "learning",
      priority: 100,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const course = await deps.courseStore.createCourse({
          clientId: clientIdFromContext(context),
          title: readRequiredString(value, "title"),
          topic: readRequiredString(value, "topic"),
          courseId: readOptionalString(value, "courseId"),
          description: readOptionalString(value, "description"),
          learnerProfile: readOptionalRecord(value, "learnerProfile") as LearningCourse["learnerProfile"],
          preferences: readOptionalRecord(value, "preferences") as LearningPreferences | undefined,
          context: readOptionalRecord(value, "context") as CourseContext | undefined,
          modules: readOptionalArray(value, "modules") as CourseModuleInput[] | undefined,
          activate: typeof value["activate"] === "boolean" ? value["activate"] : undefined,
        });
        return coursePayload(course, deps.courseStore.courseFileSummary(course.courseId));
      });
    },
  };
}

function createListCoursesTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_list_courses",
    description: "List saved learning courses for the current client.",
    inputSchema: {
      type: "object",
      properties: {
        includeArchived: { type: "boolean", description: "Include archived courses. Defaults to false." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "list"],
      domain: "learning",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const courses = await deps.courseStore.listCourses(clientIdFromContext(context), {
          includeArchived: typeof value["includeArchived"] === "boolean" ? value["includeArchived"] : false,
        });
        return {
          courses: courses.map((course) => courseSummary(course, deps.courseStore.courseFileSummary(course.courseId))),
          total: courses.length,
        };
      });
    },
  };
}

function createActivateCourseTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_activate_course",
    description: "Activate one learning course for the current client and pause the previous active course.",
    inputSchema: {
      type: "object",
      required: ["courseId"],
      properties: {
        courseId: { type: "string", description: "Course id to activate." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "activate", "switch"],
      domain: "learning",
      priority: 100,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const course = await deps.courseStore.activateCourse(
          clientIdFromContext(context),
          readRequiredString(value, "courseId"),
        );
        return coursePayload(course, deps.courseStore.courseFileSummary(course.courseId));
      });
    },
  };
}

function createGetActiveCourseTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_get_active_course",
    description: "Return the active learning course for the current client.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "active", "continue"],
      domain: "learning",
      priority: 100,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const course = await deps.courseStore.getActiveCourse(clientIdFromContext(context));
        if (!course) {
          return { activeCourse: null };
        }
        return { activeCourse: coursePayload(course, deps.courseStore.courseFileSummary(course.courseId)) };
      });
    },
  };
}

function createGetActiveLearningContextTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_get_active_learning_context",
    description: "Return the compact active-course context capsule used for first-principles tutoring decisions.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "active", "context", "course", "first principles"],
      domain: "learning",
      priority: 115,
    },
    async execute(_input, context): Promise<ToolResult> {
      return withJsonResult(async () => ({
        activeLearningContext: await deps.courseStore.getActiveLearningContext(clientIdFromContext(context)),
      }));
    },
  };
}

function createGetActiveLessonContextTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_get_active_lesson_context",
    description: "Return the metadata for the active visible lesson, including concepts, examples, first-principles notes, and summary for answering doubts.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        lessonId: { type: "string", description: "Optional lesson id. Defaults to course active lesson." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "lesson", "context", "doubt", "active"],
      domain: "learning",
      priority: 120,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return {
          lessonContext: await deps.courseStore.getActiveLessonMetadata(
            clientIdFromContext(context),
            readOptionalString(value, "courseId"),
            readOptionalString(value, "lessonId"),
          ),
        };
      });
    },
  };
}

function createGetCourseTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_get_course",
    description: "Read a specific course, or the active course when courseId is omitted.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "read", "metadata"],
      domain: "learning",
      priority: 90,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const clientId = clientIdFromContext(context);
        const courseId = readOptionalString(value, "courseId");
        const course = courseId
          ? await deps.courseStore.getCourse(courseId, clientId)
          : await requireActiveCourse(deps.courseStore, clientId);
        return coursePayload(course, deps.courseStore.courseFileSummary(course.courseId));
      });
    },
  };
}

function createUpdateCourseContextTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_update_course_context",
    description: "Merge newly gathered learning preferences or course context into a course.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        description: { type: "string", description: "Updated short course description." },
        preferences: preferencesSchema(),
        context: contextSchema(),
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "context", "preferences", "update"],
      domain: "learning",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const course = await deps.courseStore.updateCourseContext({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          description: readOptionalString(value, "description"),
          preferences: readOptionalRecord(value, "preferences") as LearningPreferences | undefined,
          context: readOptionalRecord(value, "context") as CourseContext | undefined,
        });
        return coursePayload(course, deps.courseStore.courseFileSummary(course.courseId));
      });
    },
  };
}

function createPlanNextLessonTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_plan_next_lesson",
    description: "Plan the next single lesson from the active course map and learning index before generating content. Use this to avoid duplicates and wrong direction.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        focus: { type: "string", description: "Optional requested focus/topic from the user." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "plan", "next lesson", "duplicates", "direction"],
      domain: "learning",
      priority: 125,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.courseStore.planNextLesson({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          focus: readOptionalString(value, "focus"),
        });
      });
    },
  };
}

function createContinueCourseTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_continue_course",
    description: "Generate exactly one next lesson for a course and open it in the visual learning workspace when available.",
    inputSchema: {
      type: "object",
      required: ["html"],
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        moduleId: { type: "string", description: "Optional module id. Used to pick the next planned lesson." },
        lessonId: { type: "string", description: "Optional planned lesson id to generate." },
        title: { type: "string", description: "Lesson title. Required when no planned lesson is available." },
        summary: { type: "string", description: "Short lesson summary for future context." },
        objectives: {
          type: "array",
          items: { type: "string" },
          description: "Learning objectives covered by this lesson.",
        },
        html: { type: "string", description: "Lesson HTML body or complete HTML document." },
        css: { type: "string", description: "Optional lesson stylesheet content." },
        js: { type: "string", description: "Optional lesson JavaScript content." },
        assets: assetsSchema(),
        metadata: lessonMetadataSchema(),
        markCurrentDone: {
          type: "boolean",
          description: "Mark the current active lesson complete before generating the next one. Defaults to false.",
        },
        openWorkspace: {
          type: "boolean",
          description: "Open or refocus the Tauri learning workspace after saving the lesson. Defaults to true.",
        },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "continue", "next lesson", "tauri", "workspace"],
      domain: "learning",
      priority: 115,
      examples: [
        "Continue the active course with one new lesson.",
        "Generate the next planned lesson after the user asks to continue.",
      ],
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const clientId = clientIdFromContext(context);
        if (value["markCurrentDone"] === true) {
          await deps.courseStore.markLessonDone({
            clientId,
            courseId: readOptionalString(value, "courseId"),
          });
        }

        const result = await deps.courseStore.generateLessonPage({
          clientId,
          courseId: readOptionalString(value, "courseId"),
          moduleId: readOptionalString(value, "moduleId"),
          lessonId: readOptionalString(value, "lessonId"),
          title: readOptionalString(value, "title"),
          summary: readOptionalString(value, "summary"),
          objectives: readOptionalStringArray(value, "objectives"),
          html: readRequiredString(value, "html"),
          css: readOptionalString(value, "css"),
          js: readOptionalString(value, "js"),
          assets: readOptionalArray(value, "assets") as CourseAssetInput[] | undefined,
          metadata: readOptionalRecord(value, "metadata") as LessonMetadataInput | undefined,
        });
        const workspace = await maybeOpenWorkspace(deps, {
          clientId,
          courseId: result.course.courseId,
          lessonId: result.lesson.id,
          shouldOpen: value["openWorkspace"] !== false,
          uiContext: context?.uiContext,
        });

        return {
          policy: {
            generatedLessonCount: 1,
            remainingLessonsStayPlanned: true,
          },
          course: courseSummary(result.course, deps.courseStore.courseFileSummary(result.course.courseId)),
          lesson: lessonPayload(result.lesson),
          metadata: result.metadata,
          files: result.files,
          workspace,
        };
      });
    },
  };
}

function createGenerateLessonPageTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_generate_lesson_page",
    description: "Low-level repair tool: write one generated lesson page and optional CSS/JS/assets to the course directory. Do not use repeatedly to fill a whole course.",
    inputSchema: {
      type: "object",
      required: ["html"],
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        moduleId: { type: "string", description: "Optional module id. Used to pick or create the target module." },
        lessonId: { type: "string", description: "Optional lesson id. Defaults to the next planned lesson." },
        title: { type: "string", description: "Lesson title. Required when no planned lesson is available." },
        summary: { type: "string", description: "Short lesson summary for future context." },
        objectives: {
          type: "array",
          items: { type: "string" },
          description: "Learning objectives covered by this lesson.",
        },
        html: { type: "string", description: "Lesson HTML body or complete HTML document." },
        css: { type: "string", description: "Optional lesson stylesheet content." },
        js: { type: "string", description: "Optional lesson JavaScript content." },
        assets: assetsSchema(),
        metadata: lessonMetadataSchema(),
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "lesson", "html", "generate", "assets", "repair"],
      domain: "learning",
      priority: 60,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const result = await deps.courseStore.generateLessonPage({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          moduleId: readOptionalString(value, "moduleId"),
          lessonId: readOptionalString(value, "lessonId"),
          title: readOptionalString(value, "title"),
          summary: readOptionalString(value, "summary"),
          objectives: readOptionalStringArray(value, "objectives"),
          html: readRequiredString(value, "html"),
          css: readOptionalString(value, "css"),
          js: readOptionalString(value, "js"),
          assets: readOptionalArray(value, "assets") as CourseAssetInput[] | undefined,
          metadata: readOptionalRecord(value, "metadata") as LessonMetadataInput | undefined,
        });
        return {
          course: courseSummary(result.course, deps.courseStore.courseFileSummary(result.course.courseId)),
          lesson: lessonPayload(result.lesson),
          metadata: result.metadata,
          files: result.files,
        };
      });
    },
  };
}

function createMarkLessonDoneTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_mark_lesson_done",
    description: "Mark a lesson as completed and advance active progress.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        lessonId: { type: "string", description: "Optional lesson id. Defaults to the course active lesson." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "lesson", "done", "progress"],
      domain: "learning",
      priority: 100,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const course = await deps.courseStore.markLessonDone({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          lessonId: readOptionalString(value, "lessonId"),
        });
        return {
          course: courseSummary(course, deps.courseStore.courseFileSummary(course.courseId)),
          progress: course.progress,
        };
      });
    },
  };
}

function createGetProgressTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_get_course_progress",
    description: "Return progress summary for a course, defaulting to the active course.",
    inputSchema: {
      type: "object",
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "progress"],
      domain: "learning",
      priority: 95,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const clientId = clientIdFromContext(context);
        const courseId = readOptionalString(value, "courseId");
        const course = courseId
          ? await deps.courseStore.getCourse(courseId, clientId)
          : await requireActiveCourse(deps.courseStore, clientId);
        return {
          course: courseSummary(course, deps.courseStore.courseFileSummary(course.courseId)),
          progress: course.progress,
          totals: courseTotals(course),
        };
      });
    },
  };
}

function createAddCourseNoteTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_add_course_note",
    description: "Save a durable note for a course or lesson.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        lessonId: { type: "string", description: "Optional lesson id the note applies to." },
        text: { type: "string", description: "Note text to save." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "course", "note"],
      domain: "learning",
      priority: 85,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        const course = await deps.courseStore.addCourseNote({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          lessonId: readOptionalString(value, "lessonId"),
          text: readRequiredString(value, "text"),
        });
        return {
          course: courseSummary(course, deps.courseStore.courseFileSummary(course.courseId)),
          notes: course.notes,
        };
      });
    },
  };
}

function createRecordDoubtTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_record_doubt",
    description: "Record a learner doubt or confusion against the active course/lesson so future lessons can adapt.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: {
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        lessonId: { type: "string", description: "Optional lesson id. Defaults to active lesson." },
        text: { type: "string", description: "The learner's doubt or confusion." },
        answerSummary: { type: "string", description: "Short summary of the answer/explanation given, if already answered." },
        conceptIds: {
          type: "array",
          items: { type: "string" },
          description: "Concept ids or names linked to the doubt.",
        },
        status: { type: "string", enum: ["open", "answered"], description: "Whether this doubt is still open. Defaults to open." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "doubt", "confusion", "weak concept", "lesson"],
      domain: "learning",
      priority: 110,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.courseStore.recordDoubt({
          clientId: clientIdFromContext(context),
          courseId: readOptionalString(value, "courseId"),
          lessonId: readOptionalString(value, "lessonId"),
          text: readRequiredString(value, "text"),
          answerSummary: readOptionalString(value, "answerSummary"),
          conceptIds: readOptionalStringArray(value, "conceptIds"),
          status: readOptionalString(value, "status") === "answered" ? "answered" : "open",
        });
      });
    },
  };
}

function createSearchActiveCourseContextTool(deps: LearningSkillDeps): ToolDefinition {
  return {
    name: "learning_search_active_course_context",
    description: "Search the active course map, learning index, lesson metadata, notes, and doubts for course-specific context.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Search query." },
        courseId: { type: "string", description: "Optional course id. Defaults to active course." },
        limit: { type: "integer", description: "Maximum results, default 8." },
      },
      additionalProperties: false,
    },
    selectionHints: {
      tags: ["learning", "search", "course context", "lesson history", "doubt"],
      domain: "learning",
      priority: 105,
    },
    async execute(input, context): Promise<ToolResult> {
      return withJsonResult(async () => {
        const value = asRecord(input);
        return deps.courseStore.searchActiveCourseContext({
          clientId: clientIdFromContext(context),
          query: readRequiredString(value, "query"),
          courseId: readOptionalString(value, "courseId"),
          limit: readOptionalInteger(value, "limit"),
        });
      });
    },
  };
}

async function maybeOpenWorkspace(
  deps: LearningSkillDeps,
  input: {
    clientId: string;
    courseId: string;
    lessonId: string;
    shouldOpen: boolean;
    uiContext?: ToolExecutionContext["uiContext"];
  },
): Promise<unknown> {
  if (!input.shouldOpen) {
    return { opened: false, reason: "openWorkspace was false" };
  }
  if (!deps.learningWorkspace) {
    return { opened: false, reason: "learning workspace controller is not configured" };
  }
  return deps.learningWorkspace.open({
    clientId: input.clientId,
    courseId: input.courseId,
    lessonId: input.lessonId,
    uiContext: input.uiContext,
  });
}

function ensureFirstLessonInOutline(
  modules: CourseModuleInput[] | undefined,
  lesson: {
    lessonId?: string;
    moduleId?: string;
    title: string;
    summary?: string;
    objectives?: string[];
  },
): CourseModuleInput[] {
  const outline = modules && modules.length > 0
    ? modules.map((module) => ({
      ...module,
      lessons: [...(module.lessons ?? [])],
    }))
    : [{
      ...(lesson.moduleId ? { id: lesson.moduleId } : {}),
      title: "Foundations",
      summary: "Starting point and core orientation for the course.",
      lessons: [],
    }];

  const targetModule = lesson.moduleId
    ? outline.find((module) => module.id === lesson.moduleId) ?? outline[0]
    : outline[0];
  if (!targetModule) {
    return outline;
  }

  const firstLesson: CourseLessonInput = {
    ...(lesson.lessonId ? { id: lesson.lessonId } : {}),
    title: lesson.title,
    ...(lesson.summary ? { summary: lesson.summary } : {}),
    ...(lesson.objectives ? { objectives: lesson.objectives } : {}),
  };
  const exists = (targetModule.lessons ?? []).some((candidate) => {
    if (lesson.lessonId && candidate.id === lesson.lessonId) {
      return true;
    }
    return candidate.title.trim().toLowerCase() === lesson.title.trim().toLowerCase();
  });
  if (!exists) {
    targetModule.lessons = [firstLesson, ...(targetModule.lessons ?? [])];
  }

  return outline;
}

async function withJsonResult(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const output = await fn();
    return { ok: true, output: JSON.stringify(output, null, 2) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function requireActiveCourse(courseStore: CourseStore, clientId: string): Promise<LearningCourse> {
  const course = await courseStore.getActiveCourse(clientId);
  if (!course) {
    throw new Error("No active course is selected. Activate or create a course first.");
  }
  return course;
}

function coursePayload(course: LearningCourse, files: CourseFileSummary): Record<string, unknown> {
  return {
    course: {
      ...course,
      files,
      totals: courseTotals(course),
    },
  };
}

function courseSummary(course: LearningCourse, files: CourseFileSummary): Record<string, unknown> {
  const totals = courseTotals(course);
  return {
    courseId: course.courseId,
    title: course.title,
    topic: course.topic,
    status: course.status,
    activeLessonId: course.progress.activeLessonId ?? null,
    completedLessonIds: course.progress.completedLessonIds,
    totals,
    files,
    updatedAt: course.updatedAt,
  };
}

function courseTotals(course: LearningCourse): Record<string, number> {
  const lessons = course.modules.flatMap((module) => module.lessons);
  return {
    modules: course.modules.length,
    lessons: lessons.length,
    planned: lessons.filter((lesson) => lesson.status === "planned").length,
    generated: lessons.filter((lesson) => lesson.status === "generated").length,
    completed: lessons.filter((lesson) => lesson.status === "completed").length,
  };
}

function lessonPayload(lesson: CourseLesson): Record<string, unknown> {
  return {
    lessonId: lesson.id,
    title: lesson.title,
    status: lesson.status,
    summary: lesson.summary ?? null,
    objectives: lesson.objectives,
    htmlPath: lesson.htmlPath ?? null,
    cssPath: lesson.cssPath ?? null,
    jsPath: lesson.jsPath ?? null,
    assetPaths: lesson.assetPaths,
    generatedAt: lesson.generatedAt ?? null,
    completedAt: lesson.completedAt ?? null,
  };
}

function learnerProfileSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      age: { type: "string" },
      qualification: { type: "string" },
      background: { type: "string" },
      motivation: { type: "string" },
      knownStrengths: {
        type: "array",
        items: { type: "string" },
      },
      knownWeaknesses: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: true,
  };
}

function preferencesSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      level: { type: "string" },
      preferredStyle: { type: "string" },
      pace: { type: "string" },
      language: { type: "string" },
      availableTime: { type: "string" },
      examples: {
        type: "array",
        items: { type: "string" },
      },
      includeProjects: { type: "boolean" },
      includeQuizzes: { type: "boolean" },
      notes: { type: "string" },
    },
    additionalProperties: true,
  };
}

function lessonMetadataSchema(): Record<string, unknown> {
  return {
    type: "object",
    description: "Agent-readable lesson meaning. Store the first-principles structure separately from visual HTML.",
    properties: {
      purpose: { type: "string" },
      primitiveIdeas: {
        type: "array",
        items: { type: "string" },
      },
      firstPrinciples: {
        type: "array",
        items: { type: "string" },
      },
      conceptsIntroduced: {
        type: "array",
        items: { type: "string" },
      },
      conceptsPracticed: {
        type: "array",
        items: { type: "string" },
      },
      prerequisitesUsed: {
        type: "array",
        items: { type: "string" },
      },
      examplesUsed: {
        type: "array",
        items: { type: "string" },
      },
      exercises: {
        type: "array",
        items: {
          type: "object",
          required: ["prompt"],
          properties: {
            id: { type: "string" },
            prompt: { type: "string" },
            expectedInsight: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      visualSections: {
        type: "array",
        items: {
          type: "object",
          required: ["title"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            htmlAnchor: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      commonDoubts: {
        type: "array",
        items: { type: "string" },
      },
      summaryForAgent: { type: "string" },
      nextSuggestedConcepts: {
        type: "array",
        items: { type: "string" },
      },
      avoidRepeating: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: false,
  };
}

function contextSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      userGoal: { type: "string" },
      currentKnowledge: { type: "string" },
      targetOutcome: { type: "string" },
      constraints: {
        type: "array",
        items: { type: "string" },
      },
      sourceSummary: { type: "string" },
      gatheredQuestions: {
        type: "array",
        items: { type: "string" },
      },
      gatheredAnswers: {
        type: "array",
        items: { type: "string" },
      },
      notes: {
        type: "array",
        items: { type: "string" },
      },
    },
    additionalProperties: true,
  };
}

function modulesSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      required: ["title"],
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        lessons: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              summary: { type: "string" },
              objectives: {
                type: "array",
                items: { type: "string" },
              },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  };
}

function lessonContentSchema(input: { description: string; requireHtml: boolean }): Record<string, unknown> {
  return {
    type: "object",
    required: input.requireHtml ? ["title", "html"] : ["title"],
    description: input.description,
    properties: {
      moduleId: { type: "string", description: "Optional module id for this lesson." },
      lessonId: { type: "string", description: "Optional lesson id for this lesson." },
      title: { type: "string", description: "Lesson title." },
      summary: { type: "string", description: "Short lesson summary for future context." },
      objectives: {
        type: "array",
        items: { type: "string" },
        description: "Learning objectives covered by this lesson.",
      },
      html: { type: "string", description: "Lesson HTML body or complete HTML document." },
      css: { type: "string", description: "Optional lesson stylesheet content." },
      js: { type: "string", description: "Optional lesson JavaScript content." },
      assets: assetsSchema(),
      metadata: lessonMetadataSchema(),
    },
    additionalProperties: false,
  };
}

function assetsSchema(): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      required: ["fileName", "content"],
      properties: {
        fileName: { type: "string", description: "Relative asset filename under course assets/." },
        content: { type: "string", description: "Asset content as UTF-8 text or base64." },
        encoding: { type: "string", enum: ["utf8", "base64"] },
      },
      additionalProperties: false,
    },
    description: "Optional text or base64 assets, such as SVGs, images, or video files.",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRequiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function readOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readOptionalRecord(record: Record<string, unknown>, field: string): Record<string, unknown> | undefined {
  const value = record[field];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readOptionalArray(record: Record<string, unknown>, field: string): unknown[] | undefined {
  const value = record[field];
  return Array.isArray(value) ? value : undefined;
}

function readOptionalStringArray(record: Record<string, unknown>, field: string): string[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => typeof entry === "string" && entry.trim() ? [entry.trim()] : []);
}

function readOptionalInteger(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function clientIdFromContext(context: ToolExecutionContext | undefined): string {
  return context?.clientId?.trim() || "local";
}
