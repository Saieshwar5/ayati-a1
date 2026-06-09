import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type LearningMode = "inactive" | "learning";

export interface LearningActiveState {
  schemaVersion: 2;
  activeInterestId?: string;
  learningMode: LearningMode;
  activeLessonId?: string;
  activeViewPath?: string;
  lastActivatedAt?: string;
  lastLearningTurnAt?: string;
  updatedAt: string;
}

export interface LearningLessonSummary {
  lessonId: string;
  title: string;
  rootPath: string;
  lessonPath: string;
  viewPath?: string;
  viewRelativePath?: string;
  updatedAt?: string;
}

export interface LearningInterestSummary {
  interestId: string;
  title: string;
  rootPath: string;
  coursePath: string;
  indexPath: string;
  feedbackPath: string;
  logPath: string;
  lessonsDir: string;
  lessons: LearningLessonSummary[];
  latestLesson?: LearningLessonSummary;
}

export interface LearningFileStatus {
  schemaVersion: 2;
  rootPath: string;
  systemDir: string;
  interestsDir: string;
  protocolPath: string;
  preferencesPath: string;
  activePath: string;
  activeState: LearningActiveState;
  interests: LearningInterestSummary[];
  activeInterest?: LearningInterestSummary;
}

export interface LearningPromptContext {
  included: boolean;
  reason: string;
  context: string;
}

export interface LearningFileStoreOptions {
  dataDir: string;
  now?: () => Date;
}

const ACTIVE_FILE = "active.json";
const PREFERENCES_FILE = "preferences.md";
const PROTOCOL_FILE = "protocol.md";

const DEFAULT_PREFERENCES = `# Learning Preferences

Use this file for durable user-level learning preferences.

## Style
- Start at the surface, then go deeper through questions.
- Prefer first-principles explanations over textbook summaries.
- Build curiosity before details.

## Pace
- Teach one useful step at a time.

## Examples The User Likes
- Add examples here as they are discovered.

## Things To Avoid
- Do not generate a full course plan up front.
- Do not keep lesson navigation visible when it steals reading space.
`;

const DEFAULT_PROTOCOL = `# Learning V2 Filesystem Protocol

Learning is a durable filesystem thread, not a traditional course platform.

## Root
- system/active.json tracks the active interest and mode.
- system/preferences.md stores user-level learning preferences.
- interests/<interest-id>/ stores each learning thread.

## Interest Files
- course.md: what the user wants to learn, why, target outcome, current level, personalization notes.
- index.md: the compact progress card and next-step decision source.
- feedback.md: doubts, notes, confusion, and reactions.
- log.md: chronological learning history.
- lessons/<lesson-id>/lesson.md: agent-readable lesson truth.
- lessons/<lesson-id>/view.html, style.css, script.js: visual surface.

## Lesson Content
Write lesson.md first. Use this shape:
- The Surface
- The Question
- Why This Question Matters
- First Principle
- Step-by-Step Descent
- Example
- Try This
- Checkpoint Question
- New Questions Created
- Index Update

## Rules
- Create only one next lesson at a time.
- Do not create a full syllabus up front.
- Start simple, then go deep through curiosity questions.
- Update index.md after each lesson or important doubt.
- Use responsive visual layouts: lesson content first, navigation as a collapsible drawer.
`;

const LEARNING_KEYWORDS = [
  "learn",
  "learning",
  "lesson",
  "course",
  "interest",
  "study",
  "teach",
  "continue",
  "next lesson",
  "next topic",
  "doubt",
  "confused",
  "confusion",
  "understand",
  "first principle",
  "first principles",
  "checkpoint",
  "exercise",
  "review",
  "practice",
  "go deeper",
  "explain deeper",
  "show lesson",
  "open lesson",
];

const AMBIGUOUS_LEARNING_PHRASES = [
  "next",
  "continue",
  "go on",
  "why",
  "how",
  "i don't understand",
  "i do not understand",
  "explain",
];

export class LearningFileStore {
  readonly rootDir: string;
  readonly systemDir: string;
  readonly interestsDir: string;

  private readonly nowProvider: () => Date;

  constructor(options: LearningFileStoreOptions) {
    this.rootDir = resolve(options.dataDir, "learning");
    this.systemDir = resolve(this.rootDir, "system");
    this.interestsDir = resolve(this.rootDir, "interests");
    this.nowProvider = options.now ?? (() => new Date());
  }

  async ensureBase(): Promise<void> {
    await mkdir(this.systemDir, { recursive: true });
    await mkdir(this.interestsDir, { recursive: true });
    await writeFileIfMissing(this.protocolPath(), DEFAULT_PROTOCOL);
    await writeFileIfMissing(this.preferencesPath(), DEFAULT_PREFERENCES);
    if (!existsSync(this.activePath())) {
      await writeJsonAtomic(this.activePath(), this.defaultActiveState());
    }
  }

  async getStatus(): Promise<LearningFileStatus> {
    await this.ensureBase();
    const activeState = await this.readActiveState();
    const interests = await this.listInterests();
    const activeInterest = activeState.activeInterestId
      ? interests.find((interest) => interest.interestId === activeState.activeInterestId)
      : undefined;
    return {
      schemaVersion: 2,
      rootPath: this.rootDir,
      systemDir: this.systemDir,
      interestsDir: this.interestsDir,
      protocolPath: this.protocolPath(),
      preferencesPath: this.preferencesPath(),
      activePath: this.activePath(),
      activeState,
      interests,
      ...(activeInterest ? { activeInterest } : {}),
    };
  }

  async markLearningTurn(input: {
    interestId?: string;
    lessonId?: string;
    viewPath?: string;
  }): Promise<LearningFileStatus> {
    const status = await this.getStatus();
    const interestId = normalizeIdentifier(input.interestId ?? status.activeState.activeInterestId ?? "", "interestId");
    if (!interestId) {
      throw new Error("No active learning interest is selected. Create an interest and set system/active.json first.");
    }

    const interest = status.interests.find((candidate) => candidate.interestId === interestId);
    if (!interest) {
      throw new Error(`Learning interest "${interestId}" does not exist under ${this.interestsDir}.`);
    }

    const lessonId = optionalTrim(input.lessonId) ?? status.activeState.activeLessonId ?? interest.latestLesson?.lessonId;
    const activeViewPath = this.resolveActiveViewPath({
      interest,
      lessonId,
      viewPath: input.viewPath,
    });
    const now = this.nowIso();
    await writeJsonAtomic(this.activePath(), {
      ...status.activeState,
      schemaVersion: 2,
      activeInterestId: interestId,
      learningMode: "learning",
      ...(lessonId ? { activeLessonId: lessonId } : {}),
      ...(activeViewPath ? { activeViewPath } : {}),
      lastActivatedAt: status.activeState.lastActivatedAt ?? now,
      lastLearningTurnAt: now,
      updatedAt: now,
    } satisfies LearningActiveState);
    return this.getStatus();
  }

  async renderPromptContext(userMessage: string): Promise<LearningPromptContext> {
    const status = await this.getStatus();
    const decision = shouldLoadLearningContext(status, userMessage);
    if (!decision.load) {
      return { included: false, reason: decision.reason, context: "" };
    }

    const active = status.activeInterest;
    if (!active) {
      return { included: false, reason: "No active learning interest directory exists.", context: "" };
    }

    const [course, index, preferences, feedback, lesson] = await Promise.all([
      readTextIfExists(active.coursePath, 2_400),
      readTextIfExists(active.indexPath, 4_500),
      readTextIfExists(status.preferencesPath, 1_800),
      readTextIfExists(active.feedbackPath, 2_400, "tail"),
      active.latestLesson ? readTextIfExists(active.latestLesson.lessonPath, 3_000) : Promise.resolve(""),
    ]);

    const lines = [
      "# Active Learning V2 Context",
      "Use this only for learning turns. Prefer filesystem tools for course state. Generate one curiosity-driven, first-principles lesson at a time.",
      `- learning_root: ${status.rootPath}`,
      `- active_interest: ${active.title} (${active.interestId})`,
      `- learning_mode: ${status.activeState.learningMode}`,
      ...(status.activeState.activeLessonId ? [`- active_lesson: ${status.activeState.activeLessonId}`] : []),
      ...(status.activeState.activeViewPath ? [`- active_view: ${status.activeState.activeViewPath}`] : []),
      "",
      "## File Contract",
      `- course: ${active.coursePath}`,
      `- index: ${active.indexPath}`,
      `- feedback: ${active.feedbackPath}`,
      `- log: ${active.logPath}`,
      `- lessons_dir: ${active.lessonsDir}`,
      "",
      "## User Learning Preferences",
      trimForPrompt(preferences || "(none yet)"),
      "",
      "## Course Metadata",
      trimForPrompt(course || "(course.md is missing or empty)"),
      "",
      "## Learning Index",
      trimForPrompt(index || "(index.md is missing or empty)"),
      "",
      "## Recent Feedback",
      trimForPrompt(feedback || "(none yet)"),
      "",
      "## Latest Lesson",
      trimForPrompt(lesson || "(no generated lesson yet)"),
    ];

    return { included: true, reason: decision.reason, context: lines.join("\n") };
  }

  resolveFilePath(relativePath: string): string {
    const normalized = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");
    const resolved = resolve(this.rootDir, normalized);
    assertInsideRoot(this.rootDir, resolved, "Learning file path escapes the learning root.");
    return resolved;
  }

  relativeToRoot(path: string): string {
    const resolved = isAbsolute(path) ? resolve(path) : resolve(this.rootDir, path);
    assertInsideRoot(this.rootDir, resolved, "Learning file path escapes the learning root.");
    return toPortablePath(relative(this.rootDir, resolved));
  }

  protocolPath(): string {
    return join(this.systemDir, PROTOCOL_FILE);
  }

  preferencesPath(): string {
    return join(this.systemDir, PREFERENCES_FILE);
  }

  activePath(): string {
    return join(this.systemDir, ACTIVE_FILE);
  }

  private async readActiveState(): Promise<LearningActiveState> {
    await this.ensureBase();
    try {
      const raw = JSON.parse(await readFile(this.activePath(), "utf8")) as unknown;
      return normalizeActiveState(raw, this.nowIso());
    } catch {
      return this.defaultActiveState();
    }
  }

  private async listInterests(): Promise<LearningInterestSummary[]> {
    await mkdir(this.interestsDir, { recursive: true });
    const entries = await readdir(this.interestsDir, { withFileTypes: true });
    const interests = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readInterestSummary(entry.name)));
    return interests.sort((a, b) => a.title.localeCompare(b.title));
  }

  private async readInterestSummary(rawInterestId: string): Promise<LearningInterestSummary> {
    const interestId = normalizeIdentifier(rawInterestId, "interestId") || rawInterestId;
    const rootPath = join(this.interestsDir, interestId);
    const coursePath = join(rootPath, "course.md");
    const indexPath = join(rootPath, "index.md");
    const feedbackPath = join(rootPath, "feedback.md");
    const logPath = join(rootPath, "log.md");
    const lessonsDir = join(rootPath, "lessons");
    const title = await readMarkdownTitle(coursePath, titleFromSlug(interestId));
    const lessons = await this.listLessons(lessonsDir);
    const latestLesson = [...lessons].sort(compareLessonByUpdatedAtDesc)[0];
    return {
      interestId,
      title,
      rootPath,
      coursePath,
      indexPath,
      feedbackPath,
      logPath,
      lessonsDir,
      lessons,
      ...(latestLesson ? { latestLesson } : {}),
    };
  }

  private async listLessons(lessonsDir: string): Promise<LearningLessonSummary[]> {
    if (!existsSync(lessonsDir)) {
      return [];
    }
    const entries = await readdir(lessonsDir, { withFileTypes: true });
    const lessons = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const lessonId = entry.name;
        const rootPath = join(lessonsDir, lessonId);
        const lessonPath = join(rootPath, "lesson.md");
        const viewPath = join(rootPath, "view.html");
        const title = await readMarkdownTitle(lessonPath, titleFromSlug(lessonId));
        const updatedAt = await latestMtimeIso([lessonPath, viewPath]);
        return {
          lessonId,
          title,
          rootPath,
          lessonPath,
          ...(existsSync(viewPath) ? { viewPath, viewRelativePath: this.relativeToRoot(viewPath) } : {}),
          ...(updatedAt ? { updatedAt } : {}),
        };
      }));
    return lessons.sort((a, b) => a.lessonId.localeCompare(b.lessonId));
  }

  private resolveActiveViewPath(input: {
    interest: LearningInterestSummary;
    lessonId?: string;
    viewPath?: string;
  }): string | undefined {
    if (input.viewPath?.trim()) {
      return this.relativeToRoot(input.viewPath.trim());
    }
    if (!input.lessonId) {
      return input.interest.latestLesson?.viewRelativePath;
    }
    const lesson = input.interest.lessons.find((candidate) => candidate.lessonId === input.lessonId);
    if (lesson?.viewRelativePath) {
      return lesson.viewRelativePath;
    }
    const candidatePath = join(input.interest.lessonsDir, input.lessonId, "view.html");
    return existsSync(candidatePath) ? this.relativeToRoot(candidatePath) : undefined;
  }

  private defaultActiveState(): LearningActiveState {
    return {
      schemaVersion: 2,
      learningMode: "inactive",
      updatedAt: this.nowIso(),
    };
  }

  private nowIso(): string {
    return this.nowProvider().toISOString();
  }
}

export function shouldLoadLearningContext(
  status: LearningFileStatus,
  userMessage: string,
): { load: boolean; reason: string } {
  const active = status.activeInterest;
  if (!status.activeState.activeInterestId) {
    return { load: false, reason: "No active learning interest." };
  }
  if (!active) {
    return { load: false, reason: "Active learning interest directory is missing." };
  }

  const message = normalizeText(userMessage);
  if (!message) {
    return { load: status.activeState.learningMode === "learning", reason: "Learning mode is active." };
  }

  if (LEARNING_KEYWORDS.some((keyword) => message.includes(keyword))) {
    return { load: true, reason: "User message is learning-related." };
  }

  const topicTokens = new Set([
    ...tokenize(active.interestId),
    ...tokenize(active.title),
  ].filter((token) => token.length >= 4));
  const messageTokens = new Set(tokenize(message));
  const mentionsTopic = [...topicTokens].some((token) => messageTokens.has(token));
  if (mentionsTopic) {
    return { load: true, reason: "User message mentions the active learning topic." };
  }

  if (
    status.activeState.learningMode === "learning"
    && AMBIGUOUS_LEARNING_PHRASES.some((phrase) => message.includes(phrase))
  ) {
    return { load: true, reason: "Learning mode is active and the message can continue the lesson." };
  }

  return { load: false, reason: "User message is not learning-related." };
}

function normalizeActiveState(raw: unknown, fallbackUpdatedAt: string): LearningActiveState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      schemaVersion: 2,
      learningMode: "inactive",
      updatedAt: fallbackUpdatedAt,
    };
  }
  const record = raw as Record<string, unknown>;
  const activeInterestId = typeof record["activeInterestId"] === "string"
    ? normalizeIdentifier(record["activeInterestId"], "activeInterestId")
    : undefined;
  const learningMode = record["learningMode"] === "learning" ? "learning" : "inactive";
  return {
    schemaVersion: 2,
    ...(activeInterestId ? { activeInterestId } : {}),
    learningMode,
    ...(typeof record["activeLessonId"] === "string" && record["activeLessonId"].trim()
      ? { activeLessonId: record["activeLessonId"].trim() }
      : {}),
    ...(typeof record["activeViewPath"] === "string" && record["activeViewPath"].trim()
      ? { activeViewPath: toPortablePath(record["activeViewPath"].trim()) }
      : {}),
    ...(typeof record["lastActivatedAt"] === "string" ? { lastActivatedAt: record["lastActivatedAt"] } : {}),
    ...(typeof record["lastLearningTurnAt"] === "string" ? { lastLearningTurnAt: record["lastLearningTurnAt"] } : {}),
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : fallbackUpdatedAt,
  };
}

function normalizeIdentifier(value: string, fieldName: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug && value.trim()) {
    throw new Error(`${fieldName} must contain at least one letter or number.`);
  }
  return slug;
}

async function writeFileIfMissing(path: string, content: string): Promise<void> {
  if (existsSync(path)) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function readTextIfExists(path: string, maxChars: number, mode: "head" | "tail" = "head"): Promise<string> {
  try {
    const raw = await readFile(path, "utf8");
    if (raw.length <= maxChars) {
      return raw.trim();
    }
    if (mode === "tail") {
      return `[tail truncated]\n${raw.slice(-maxChars).trim()}`;
    }
    return `${raw.slice(0, maxChars).trim()}\n[truncated]`;
  } catch {
    return "";
  }
}

async function readMarkdownTitle(path: string, fallback: string): Promise<string> {
  const text = await readTextIfExists(path, 2_000);
  const heading = text.split(/\r?\n/).find((line) => /^#\s+/.test(line));
  return heading?.replace(/^#\s+/, "").trim() || fallback;
}

async function latestMtimeIso(paths: string[]): Promise<string | undefined> {
  const times = await Promise.all(paths.map(async (path) => {
    try {
      const { stat } = await import("node:fs/promises");
      return (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  }));
  const latest = Math.max(...times);
  return latest > 0 ? new Date(latest).toISOString() : undefined;
}

function compareLessonByUpdatedAtDesc(a: LearningLessonSummary, b: LearningLessonSummary): number {
  const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  if (aTime !== bTime) {
    return bTime - aTime;
  }
  return b.lessonId.localeCompare(a.lessonId);
}

function titleFromSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || basename(slug);
}

function trimForPrompt(value: string): string {
  return value.trim() || "(empty)";
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function assertInsideRoot(root: string, candidate: string, message: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  if (normalizedCandidate !== normalizedRoot && !normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(message);
  }
}
