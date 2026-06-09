import "./styles.css";

interface LearningActiveState {
  activeInterestId?: string;
  learningMode: "inactive" | "learning";
  activeLessonId?: string;
  activeViewPath?: string;
}

interface LearningLessonSummary {
  lessonId: string;
  title: string;
  viewRelativePath?: string;
}

interface LearningInterestSummary {
  interestId: string;
  title: string;
  coursePath: string;
  indexPath: string;
  feedbackPath: string;
  lessonsDir: string;
  lessons: LearningLessonSummary[];
  latestLesson?: LearningLessonSummary;
}

interface LearningFileStatus {
  rootPath: string;
  protocolPath: string;
  preferencesPath: string;
  activePath: string;
  activeState: LearningActiveState;
  interests: LearningInterestSummary[];
  activeInterest?: LearningInterestSummary;
}

interface WorkspaceState {
  isOpen: boolean;
  launchStatus: string;
  activeCourseId?: string;
  activeInterestId?: string;
  activeLessonId?: string;
  activeViewPath?: string;
  learningVersion?: "v1" | "v2";
  lastCommand?: string;
  lastCommandId?: string;
}

interface InterestPayload {
  interest: LearningInterestSummary;
  course: string;
  index: string;
  feedback: string;
}

interface AppState {
  apiBase: string;
  status: LearningFileStatus | null;
  selectedInterestId: string | null;
  selectedLessonId: string | null;
  selectedInterest: InterestPayload | null;
  workspaceCommandId: string | null;
  navOpen: boolean;
  statusText: string;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) {
  throw new Error("Missing #app root.");
}

const state: AppState = {
  apiBase: resolveApiBase(),
  status: null,
  selectedInterestId: null,
  selectedLessonId: null,
  selectedInterest: null,
  workspaceCommandId: null,
  navOpen: false,
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
    const [statusPayload, workspacePayload] = await Promise.all([
      fetchJson<{ status: LearningFileStatus }>("/api/learning/v2/status"),
      fetchJson<{ state: WorkspaceState | null }>("/api/learning/workspace-state"),
    ]);
    state.status = statusPayload.status;
    const workspace = workspacePayload.state;
    state.selectedInterestId = workspace?.activeInterestId
      ?? workspace?.activeCourseId
      ?? statusPayload.status.activeState.activeInterestId
      ?? statusPayload.status.interests[0]?.interestId
      ?? null;
    state.selectedLessonId = workspace?.activeLessonId
      ?? statusPayload.status.activeState.activeLessonId
      ?? selectedInterestSummary()?.latestLesson?.lessonId
      ?? selectedInterestSummary()?.lessons[0]?.lessonId
      ?? null;
    state.workspaceCommandId = workspace?.lastCommandId ?? null;
    state.statusText = "Ready";
    await ensureSelectedInterestLoaded();
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
      const nextInterestId = workspace.activeInterestId ?? workspace.activeCourseId;
      if (nextInterestId) {
        state.selectedInterestId = nextInterestId;
        state.selectedInterest = null;
        await ensureSelectedInterestLoaded();
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
  } catch {
    return;
  }
}

async function ensureSelectedInterestLoaded(): Promise<void> {
  const interestId = state.selectedInterestId;
  if (!interestId) {
    return;
  }
  if (state.selectedInterest?.interest.interestId === interestId) {
    return;
  }
  const payload = await fetchJson<InterestPayload>(`/api/learning/v2/interests/${encodeURIComponent(interestId)}`);
  state.selectedInterest = payload;
  state.selectedLessonId = state.selectedLessonId
    ?? payload.interest.latestLesson?.lessonId
    ?? payload.interest.lessons[0]?.lessonId
    ?? null;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${state.apiBase}${path}`, init);
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed with ${response.status}`);
  }
  return payload as T;
}

function selectedInterestSummary(): LearningInterestSummary | null {
  return state.status?.interests.find((interest) => interest.interestId === state.selectedInterestId) ?? null;
}

function selectedInterest(): LearningInterestSummary | null {
  return state.selectedInterest?.interest ?? selectedInterestSummary();
}

function selectedLesson(interest: LearningInterestSummary | null): LearningLessonSummary | null {
  if (!interest) {
    return null;
  }
  const lessonId = state.selectedLessonId ?? state.status?.activeState.activeLessonId;
  return interest.lessons.find((lesson) => lesson.lessonId === lessonId)
    ?? interest.latestLesson
    ?? interest.lessons[0]
    ?? null;
}

function lessonUrl(lesson: LearningLessonSummary | null): string | null {
  if (!lesson?.viewRelativePath) {
    return null;
  }
  return `${state.apiBase}/api/learning/v2/files/${encodePath(lesson.viewRelativePath)}`;
}

function render(): void {
  const interest = selectedInterest();
  const lesson = selectedLesson(interest);
  const navClass = state.navOpen ? "lesson-nav open" : "lesson-nav";
  app.innerHTML = `
    <main class="shell">
      <section class="workspace">
        <header class="topbar">
          <button class="icon-button nav-toggle" data-action="toggle-nav" title="Lessons" aria-label="Lessons">Menu</button>
          <div class="title-block">
            <p class="eyebrow">${escapeHtml(state.statusText)}</p>
            <h1>${escapeHtml(lesson?.title ?? interest?.title ?? "Learning Workspace")}</h1>
          </div>
          <div class="mode">${escapeHtml(state.status?.activeState.learningMode ?? "inactive")}</div>
        </header>
        <div class="content-grid">
          <nav class="${navClass}">
            <div class="nav-header">
              <strong>Learning</strong>
              <button class="icon-button" data-action="toggle-nav" title="Close" aria-label="Close">Close</button>
            </div>
            <div class="course-list">
              ${state.status?.interests.map((item) => interestButton(item)).join("") || "<p class=\"empty\">No interests yet</p>"}
            </div>
            ${interest ? `<div class="lesson-list">${interest.lessons.map((item) => lessonButton(item)).join("")}</div>` : ""}
          </nav>
          <section class="lesson-view">
            ${renderLessonFrame(interest, lesson)}
          </section>
        </div>
      </section>
    </main>
  `;
  bindActions();
}

function interestButton(interest: LearningInterestSummary): string {
  const active = interest.interestId === state.selectedInterestId ? " active" : "";
  return `
    <button class="course-button${active}" data-action="select-interest" data-interest-id="${escapeAttr(interest.interestId)}">
      <span>${escapeHtml(interest.title)}</span>
      <small>${interest.lessons.length} lesson${interest.lessons.length === 1 ? "" : "s"}</small>
    </button>
  `;
}

function lessonButton(lesson: LearningLessonSummary): string {
  const active = lesson.lessonId === state.selectedLessonId ? " active" : "";
  return `
    <button class="lesson-button${active}" data-action="select-lesson" data-lesson-id="${escapeAttr(lesson.lessonId)}">
      <span>${escapeHtml(lesson.title)}</span>
      <small>${lesson.viewRelativePath ? "visual ready" : "markdown only"}</small>
    </button>
  `;
}

function renderLessonFrame(interest: LearningInterestSummary | null, lesson: LearningLessonSummary | null): string {
  if (!interest) {
    return renderTextPanel("No active interest", "Create a learning interest in the filesystem to begin.");
  }

  const url = lessonUrl(lesson);
  if (!lesson || !url) {
    return renderTextPanel(interest.title, state.selectedInterest?.index || "No visual lesson has been generated yet.");
  }

  return `<iframe title="${escapeAttr(lesson.title)}" src="${escapeAttr(url)}"></iframe>`;
}

function renderTextPanel(title: string, text: string): string {
  return `
    <article class="placeholder">
      <h2>${escapeHtml(title)}</h2>
      <pre>${escapeHtml(text)}</pre>
    </article>
  `;
}

function bindActions(): void {
  app.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      void (async () => {
        if (action === "toggle-nav") {
          state.navOpen = !state.navOpen;
          render();
          return;
        }
        if (action === "select-interest" && button.dataset.interestId) {
          state.selectedInterestId = button.dataset.interestId;
          state.selectedInterest = null;
          state.selectedLessonId = null;
          await ensureSelectedInterestLoaded();
          state.navOpen = false;
          render();
          return;
        }
        if (action === "select-lesson" && button.dataset.lessonId) {
          state.selectedLessonId = button.dataset.lessonId;
          state.navOpen = false;
          render();
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

function encodePath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
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
