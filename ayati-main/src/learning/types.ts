export type CourseStatus = "active" | "paused" | "archived";
export type LessonStatus = "planned" | "generated" | "completed";
export type ConceptStatus = "unseen" | "planned" | "introduced" | "practiced" | "mastered" | "blocked";
export type DoubtStatus = "open" | "answered";

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

export interface LearnerProfile {
  age?: string;
  qualification?: string;
  background?: string;
  motivation?: string;
  knownStrengths?: string[];
  knownWeaknesses?: string[];
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

export interface CourseConcept {
  id: string;
  title: string;
  status: ConceptStatus;
  lessonIds: string[];
  prerequisites: string[];
  notes: string[];
  updatedAt?: string;
}

export interface CourseMap {
  schemaVersion: 1;
  courseId: string;
  purpose?: string;
  targetOutcome?: string;
  currentPosition?: string;
  concepts: CourseConcept[];
  nextCandidates: string[];
  avoidForNow: string[];
  wrongDirectionWarnings: string[];
  updatedAt: string;
}

export interface LearningIndex {
  schemaVersion: 1;
  courseId: string;
  learnedConcepts: string[];
  weakConcepts: string[];
  openQuestions: string[];
  completedLessons: string[];
  currentPosition?: string;
  nextLikelyTopics: string[];
  firstPrinciplesMap: string[];
  updatedAt: string;
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

export interface LessonVisualSection {
  id: string;
  title: string;
  summary?: string;
  htmlAnchor?: string;
}

export interface LessonExercise {
  id: string;
  prompt: string;
  expectedInsight?: string;
}

export interface LessonMetadataInput {
  purpose?: string;
  primitiveIdeas?: string[];
  firstPrinciples?: string[];
  conceptsIntroduced?: string[];
  conceptsPracticed?: string[];
  prerequisitesUsed?: string[];
  examplesUsed?: string[];
  exercises?: LessonExercise[];
  visualSections?: LessonVisualSection[];
  commonDoubts?: string[];
  summaryForAgent?: string;
  nextSuggestedConcepts?: string[];
  avoidRepeating?: string[];
}

export interface LessonMetadata extends LessonMetadataInput {
  schemaVersion: 1;
  courseId: string;
  lessonId: string;
  title: string;
  htmlPath?: string;
  createdAt: string;
  updatedAt: string;
  primitiveIdeas: string[];
  firstPrinciples: string[];
  conceptsIntroduced: string[];
  conceptsPracticed: string[];
  prerequisitesUsed: string[];
  examplesUsed: string[];
  exercises: LessonExercise[];
  visualSections: LessonVisualSection[];
  commonDoubts: string[];
  nextSuggestedConcepts: string[];
  avoidRepeating: string[];
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

export interface LearningDoubt {
  doubtId: string;
  courseId: string;
  lessonId?: string;
  text: string;
  answerSummary?: string;
  conceptIds: string[];
  status: DoubtStatus;
  createdAt: string;
  updatedAt: string;
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
  learnerProfile?: LearnerProfile;
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
  courseMapPath: string;
  learningIndexPath: string;
  doubtsPath: string;
  lessonsDir: string;
  assetsDir: string;
}

export interface ActiveLearningContext {
  course: {
    courseId: string;
    title: string;
    topic: string;
    purpose?: string;
    targetOutcome?: string;
    status: CourseStatus;
  };
  learnerProfile?: LearnerProfile;
  preferences: LearningPreferences;
  currentPosition?: string;
  learnedConcepts: string[];
  weakConcepts: string[];
  openQuestions: string[];
  nextLikelyTopics: string[];
  activeLesson?: LessonMetadata;
  courseMap: Pick<CourseMap, "nextCandidates" | "avoidForNow" | "wrongDirectionWarnings">;
}

export interface LessonPlan {
  courseId: string;
  nextLesson: {
    lessonId?: string;
    title: string;
    moduleId?: string;
    reason: string;
    prerequisites: string[];
    conceptsToIntroduce: string[];
    conceptsToPractice: string[];
  };
  duplicateWarnings: string[];
  wrongDirectionWarnings: string[];
  contextCapsule: ActiveLearningContext;
}
