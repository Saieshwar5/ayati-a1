export type CourseStatus = "active" | "paused" | "archived";
export type LessonStatus = "planned" | "generated" | "completed";

export interface LearningPreferences {
  level?: string;
  preferredStyle?: string;
  pace?: string;
  language?: string;
  availableTime?: string;
  examples?: string[];
  includeProjects?: boolean;
  includeQuizzes?: boolean;
  notes?: string;
}

export interface CourseContext {
  userGoal?: string;
  currentKnowledge?: string;
  targetOutcome?: string;
  constraints?: string[];
  sourceSummary?: string;
  gatheredQuestions?: string[];
  gatheredAnswers?: string[];
  notes?: string[];
}

export interface CourseLesson {
  id: string;
  title: string;
  status: LessonStatus;
  summary?: string;
  objectives: string[];
  htmlPath?: string;
  cssPath?: string;
  jsPath?: string;
  assetPaths: string[];
  generatedAt?: string;
  completedAt?: string;
}

export interface CourseModule {
  id: string;
  title: string;
  summary?: string;
  lessons: CourseLesson[];
}

export interface GeneratedContentRecord {
  lessonId: string;
  title: string;
  htmlPath: string;
  cssPath?: string;
  jsPath?: string;
  assetPaths: string[];
  generatedAt: string;
  summary?: string;
}

export interface CourseNote {
  noteId: string;
  text: string;
  lessonId?: string;
  createdAt: string;
}

export interface CourseProgress {
  activeLessonId?: string;
  completedLessonIds: string[];
  lastAccessedAt?: string;
}

export interface LearningCourse {
  schemaVersion: 1;
  courseId: string;
  clientId: string;
  title: string;
  topic: string;
  description?: string;
  status: CourseStatus;
  preferences: LearningPreferences;
  context: CourseContext;
  modules: CourseModule[];
  progress: CourseProgress;
  generatedContentHistory: GeneratedContentRecord[];
  notes: CourseNote[];
  createdAt: string;
  updatedAt: string;
}

export interface ActiveCourseState {
  schemaVersion: 1;
  clientId: string;
  activeCourseId?: string;
  updatedAt: string;
}

export interface CourseAssetInput {
  fileName: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface CourseFileSummary {
  courseId: string;
  rootPath: string;
  manifestPath: string;
  contextPath: string;
  lessonsDir: string;
  assetsDir: string;
}
