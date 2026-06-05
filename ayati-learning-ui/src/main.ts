import "./styles.css";

type LessonStatus = "planned" | "generated" | "completed";

interface CourseLesson {
  id: string;
  title: string;
  status: LessonStatus;
  summary?: string;
  objectives: string[];
  htmlPath?: string;
}

interface CourseModule {
  id: string;
  title: string;
  summary?: string;
  lessons: CourseLesson[];
}

interface LearningCourse {
  courseId: string;
  title: string;
  topic: string;
  description?: string;
  status: "active" | "paused" | "archived";
  modules: CourseModule[];
  progress: {
    activeLessonId?: string;
    completedLessonIds: string[];
  };
  updatedAt: string;
}

interface WorkspaceState {
  isOpen: boolean;
  launchStatus: string;
  activeCourseId?: string;
  activeLessonId?: string;
  lastCommand?: string;
  lastCommandId?: string;
}

interface AppState {
  apiBase: string;
  courses: LearningCourse[];
  activeCourse: LearningCourse | null;
  selectedCourseId: string | null;
  selectedLessonId: string | null;
  workspaceCommandId: string | null;
  statusText: string;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root.");
}

const state: AppState = {
  apiBase: resolveApiBase(),
  courses: [],
  activeCourse: null,
  selectedCourseId: null,
  selectedLessonId: null,
  workspaceCommandId: null,
  statusText: "Connecting",
};

render();
void refreshAll();
window.setInterval(() => void pollWorkspaceState(), 1500);

function resolveApiBase(): string {
  const url = new URL(window.location.href);
  const configured = url.searchParams.get("apiBase") || localStorage.getItem("ayati.learning.apiBase");
  const apiBase = configured?.replace(/\/+$/, "") || "http://127.0.0.1:8081";
  localStorage.setItem("ayati.learning.apiBase", apiBase);
  return apiBase;
}

async function refreshAll(): Promise<void> {
  try {
    const [coursesPayload, activePayload, workspacePayload] = await Promise.all([
      fetchJson<{ courses: LearningCourse[] }>("/api/learning/courses"),
      fetchJson<{ activeCourse: LearningCourse | null }>("/api/learning/active-course"),
      fetchJson<{ state: WorkspaceState | null }>("/api/learning/workspace-state"),
    ]);
    state.courses = coursesPayload.courses ?? [];
    state.activeCourse = activePayload.activeCourse;
    const workspace = workspacePayload.state;
    state.selectedCourseId = workspace?.activeCourseId
      ?? state.activeCourse?.courseId
      ?? state.courses[0]?.courseId
      ?? null;
    state.selectedLessonId = workspace?.activeLessonId
      ?? state.activeCourse?.progress.activeLessonId
      ?? firstLesson(state.activeCourse ?? selectedCourse())?.id
      ?? null;
    state.workspaceCommandId = workspace?.lastCommandId ?? null;
    state.statusText = "Ready";
    await ensureSelectedCourseLoaded();
  } catch (err) {
    state.statusText = err instanceof Error ? err.message : String(err);
  }
  render();
}

async function pollWorkspaceState(): Promise<void> {
  try {
    const payload = await fetchJson<{ state: WorkspaceState | null }>("/api/learning/workspace-state");
    const workspace = payload.state;
    if (!workspace) {
      return;
    }

    if (workspace.lastCommandId && workspace.lastCommandId !== state.workspaceCommandId) {
      state.workspaceCommandId = workspace.lastCommandId;
      if (workspace.activeCourseId) {
        state.selectedCourseId = workspace.activeCourseId;
        await ensureSelectedCourseLoaded();
      }
      if (workspace.activeLessonId) {
        state.selectedLessonId = workspace.activeLessonId;
      }
      if (workspace.lastCommand === "focus") {
        await focusWindow();
      }
      if (workspace.lastCommand === "close") {
        await closeWindow();
      }
      render();
      return;
    }

    if (workspace.activeCourseId && workspace.activeCourseId !== state.selectedCourseId) {
      state.selectedCourseId = workspace.activeCourseId;
      await ensureSelectedCourseLoaded();
      render();
    }
  } catch {
    return;
  }
}

async function ensureSelectedCourseLoaded(): Promise<void> {
  const courseId = state.selectedCourseId;
  if (!courseId) {
    return;
  }
  if (state.activeCourse?.courseId === courseId) {
    return;
  }
  const payload = await fetchJson<{ course: LearningCourse }>(`/api/learning/courses/${encodeURIComponent(courseId)}`);
  state.activeCourse = payload.course;
  state.selectedLessonId = state.selectedLessonId ?? firstLesson(payload.course)?.id ?? null;
}

async function activateCourse(courseId: string): Promise<void> {
  await fetchJson(`/api/learning/courses/${encodeURIComponent(courseId)}/activate`, { method: "POST" });
  state.selectedCourseId = courseId;
  state.activeCourse = null;
  await ensureSelectedCourseLoaded();
  state.selectedLessonId = state.activeCourse?.progress.activeLessonId ?? firstLesson(state.activeCourse)?.id ?? null;
  render();
}

async function completeLesson(courseId: string, lessonId: string): Promise<void> {
  const payload = await fetchJson<{ course: LearningCourse }>(
    `/api/learning/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(lessonId)}/complete`,
    { method: "POST" },
  );
  state.activeCourse = payload.course;
  state.selectedLessonId = payload.course.progress.activeLessonId ?? lessonId;
  render();
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${state.apiBase}${path}`, init);
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload as T;
}

function selectedCourse(): LearningCourse | null {
  return state.activeCourse?.courseId === state.selectedCourseId
    ? state.activeCourse
    : state.courses.find((course) => course.courseId === state.selectedCourseId) ?? null;
}

function selectedLesson(course: LearningCourse | null): CourseLesson | null {
  if (!course) {
    return null;
  }
  const lessonId = state.selectedLessonId ?? course.progress.activeLessonId;
  return course.modules.flatMap((module) => module.lessons).find((lesson) => lesson.id === lessonId)
    ?? firstLesson(course);
}

function firstLesson(course: LearningCourse | null): CourseLesson | null {
  return course?.modules.flatMap((module) => module.lessons)[0] ?? null;
}

function lessonUrl(course: LearningCourse, lesson: CourseLesson): string | null {
  if (!lesson.htmlPath) {
    return null;
  }
  return `${state.apiBase}/api/learning/courses/${encodeURIComponent(course.courseId)}/files/${lesson.htmlPath}`;
}

function render(): void {
  const course = selectedCourse();
  const lesson = selectedLesson(course);
  app.innerHTML = `
    <main class="shell">
      <aside class="courses">
        <div class="brand">
          <span>Ayati</span>
          <strong>Learning</strong>
        </div>
        <div class="course-list">
          ${state.courses.map((item) => courseButton(item)).join("") || "<p class=\"empty\">No courses yet</p>"}
        </div>
      </aside>
      <section class="workspace">
        <header class="topbar">
          <div>
            <p class="eyebrow">${escapeHtml(state.statusText)}</p>
            <h1>${escapeHtml(course?.title ?? "Learning Workspace")}</h1>
          </div>
          <div class="actions">
            ${course ? `<button data-action="activate" data-course-id="${escapeAttr(course.courseId)}">Activate</button>` : ""}
            ${course && lesson ? `<button data-action="complete" data-course-id="${escapeAttr(course.courseId)}" data-lesson-id="${escapeAttr(lesson.id)}">Complete</button>` : ""}
          </div>
        </header>
        <div class="content-grid">
          <nav class="lesson-nav">
            ${course ? course.modules.map((module) => moduleBlock(module)).join("") : ""}
          </nav>
          <section class="lesson-view">
            ${renderLessonFrame(course, lesson)}
          </section>
        </div>
      </section>
    </main>
  `;
  bindActions();
}

function courseButton(course: LearningCourse): string {
  const active = course.courseId === state.selectedCourseId ? " active" : "";
  return `
    <button class="course-button${active}" data-action="select-course" data-course-id="${escapeAttr(course.courseId)}">
      <span>${escapeHtml(course.title)}</span>
      <small>${escapeHtml(course.status)} · ${courseTotals(course)}</small>
    </button>
  `;
}

function moduleBlock(module: CourseModule): string {
  return `
    <section class="module">
      <h2>${escapeHtml(module.title)}</h2>
      ${module.lessons.map((lesson) => lessonButton(lesson)).join("")}
    </section>
  `;
}

function lessonButton(lesson: CourseLesson): string {
  const active = lesson.id === state.selectedLessonId ? " active" : "";
  return `
    <button class="lesson-button${active}" data-action="select-lesson" data-lesson-id="${escapeAttr(lesson.id)}">
      <span>${escapeHtml(lesson.title)}</span>
      <small>${escapeHtml(lesson.status)}</small>
    </button>
  `;
}

function renderLessonFrame(course: LearningCourse | null, lesson: CourseLesson | null): string {
  if (!course || !lesson) {
    return "<div class=\"placeholder\"><h2>Select a course</h2></div>";
  }

  const url = lessonUrl(course, lesson);
  if (!url) {
    return `
      <div class="placeholder">
        <h2>${escapeHtml(lesson.title)}</h2>
        <p>${escapeHtml(lesson.summary ?? "This lesson is planned but has not been generated yet.")}</p>
      </div>
    `;
  }

  return `<iframe title="${escapeAttr(lesson.title)}" src="${escapeAttr(url)}"></iframe>`;
}

function bindActions(): void {
  app.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const courseId = button.dataset.courseId;
      const lessonId = button.dataset.lessonId;
      void (async () => {
        if (action === "select-course" && courseId) {
          state.selectedCourseId = courseId;
          state.activeCourse = null;
          await ensureSelectedCourseLoaded();
          state.selectedLessonId = state.activeCourse?.progress.activeLessonId ?? firstLesson(state.activeCourse)?.id ?? null;
          render();
        }
        if (action === "select-lesson" && lessonId) {
          state.selectedLessonId = lessonId;
          render();
        }
        if (action === "activate" && courseId) {
          await activateCourse(courseId);
        }
        if (action === "complete" && courseId && lessonId) {
          await completeLesson(courseId, lessonId);
        }
      })();
    });
  });
}

async function focusWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setFocus();
  } catch {
    window.focus();
  }
}

async function closeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  } catch {
    window.close();
  }
}

function courseTotals(course: LearningCourse): string {
  const lessons = course.modules.flatMap((module) => module.lessons);
  const completed = lessons.filter((lesson) => lesson.status === "completed").length;
  return `${completed}/${lessons.length}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
