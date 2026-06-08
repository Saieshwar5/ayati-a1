import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentUiContext } from "./context.js";
import type { WorkspaceOrchestrator } from "./workspace-orchestrator.js";

export type LearningWorkspaceCommand = "open" | "focus" | "show_lesson" | "show_course" | "close";
export type LearningWorkspaceLaunchStatus = "not_started" | "starting" | "running" | "failed";
export type LearningWorkspaceArrangementStatus = "not_attempted" | "arranged" | "unavailable" | "failed";
export type LearningWorkspacePlacementPolicy = "current-agent-cli-window" | "active-workspace" | "dedicated-workspace" | "last-used";

export type HyprctlRunner = (args: string[]) => Promise<string>;

export interface LearningWorkspaceState {
  schemaVersion: 1;
  clientId: string;
  isOpen: boolean;
  launchStatus: LearningWorkspaceLaunchStatus;
  windowVisible?: boolean;
  windowAddress?: string;
  windowTitle?: string;
  windowClass?: string;
  workspaceId?: number;
  workspaceName?: string;
  terminalAddress?: string;
  placementPolicy?: LearningWorkspacePlacementPolicy;
  anchorWindowAddress?: string;
  anchorWindowTitle?: string;
  anchorWindowClass?: string;
  anchorWorkspaceId?: number;
  anchorWorkspaceName?: string;
  arrangementStatus?: LearningWorkspaceArrangementStatus;
  activeCourseId?: string;
  activeLessonId?: string;
  lastCommand?: LearningWorkspaceCommand;
  lastCommandId?: string;
  lastOpenedAt?: string;
  lastFocusedAt?: string;
  lastUpdatedAt: string;
  launchCommand?: string;
  processId?: number;
  error?: string;
  arrangementError?: string;
}

export interface LearningWorkspaceControllerOptions {
  projectRoot: string;
  dataDir: string;
  httpBaseUrl: string;
  now?: () => Date;
  spawnImpl?: typeof spawn;
  hyprctl?: HyprctlRunner;
  hyprlandEnabled?: boolean;
  workspaceOrchestrator?: WorkspaceOrchestrator;
  windowTitle?: string;
  windowClass?: string;
  windowPollAttempts?: number;
  windowPollIntervalMs?: number;
}

export interface OpenLearningWorkspaceInput {
  clientId: string;
  courseId?: string;
  lessonId?: string;
  uiContext?: AgentUiContext;
}

export class LearningWorkspaceController {
  private readonly projectRoot: string;
  private readonly statePath: string;
  private readonly httpBaseUrl: string;
  private readonly nowProvider: () => Date;
  private readonly spawnImpl: typeof spawn;
  private readonly hyprctl: HyprctlRunner;
  private readonly hyprlandEnabled: boolean;
  private readonly windowTitle: string;
  private readonly windowClass: string;
  private readonly windowPollAttempts: number;
  private readonly windowPollIntervalMs: number;
  private readonly workspaceOrchestrator?: WorkspaceOrchestrator;
  private child: ChildProcess | null = null;

  constructor(options: LearningWorkspaceControllerOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.statePath = resolve(options.dataDir, "ui", "learning-workspace.json");
    this.httpBaseUrl = options.httpBaseUrl.replace(/\/+$/, "");
    this.nowProvider = options.now ?? (() => new Date());
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.hyprctl = options.hyprctl ?? defaultHyprctlRunner;
    this.hyprlandEnabled = options.hyprlandEnabled ?? Boolean(process.env["HYPRLAND_INSTANCE_SIGNATURE"]);
    this.windowTitle = options.windowTitle?.trim() || "Ayati Learning Workspace";
    this.windowClass = options.windowClass?.trim() || "ayati-learning-ui";
    this.windowPollAttempts = Math.max(1, options.windowPollAttempts ?? 20);
    this.windowPollIntervalMs = Math.max(0, options.windowPollIntervalMs ?? 300);
    this.workspaceOrchestrator = options.workspaceOrchestrator;
  }

  async open(input: OpenLearningWorkspaceInput): Promise<LearningWorkspaceState> {
    await this.updateState(input.clientId, {
      isOpen: true,
      launchStatus: "starting",
      activeCourseId: optionalTrim(input.courseId),
      activeLessonId: optionalTrim(input.lessonId),
      lastCommand: "open",
      lastCommandId: this.commandId(),
      lastOpenedAt: this.nowIso(),
      error: undefined,
    });

    if (!this.isChildAlive()) {
      try {
        this.child = this.launchProcess(input);
        this.child.once("exit", () => {
          this.child = null;
          void this.updateState(input.clientId, {
            isOpen: false,
            launchStatus: "not_started",
            processId: undefined,
          });
        });
        await this.updateState(input.clientId, {
          launchStatus: "running",
          processId: this.child.pid,
          launchCommand: this.launchCommandLabel(),
        });
        return this.syncHyprlandWindow(input.clientId, { arrange: true, waitForWindow: true, uiContext: input.uiContext });
      } catch (err) {
        return this.updateState(input.clientId, {
          launchStatus: "failed",
          isOpen: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    await this.updateState(input.clientId, {
      launchStatus: "running",
      processId: this.child?.pid,
      launchCommand: this.launchCommandLabel(),
    });
    return this.syncHyprlandWindow(input.clientId, { arrange: true, waitForWindow: true, uiContext: input.uiContext });
  }

  async focus(clientId: string, uiContext?: AgentUiContext): Promise<LearningWorkspaceState> {
    await this.updateState(clientId, {
      isOpen: true,
      lastCommand: "focus",
      lastCommandId: this.commandId(),
      lastFocusedAt: this.nowIso(),
    });
    return this.syncHyprlandWindow(clientId, { arrange: true, waitForWindow: false, uiContext });
  }

  async showLesson(input: OpenLearningWorkspaceInput): Promise<LearningWorkspaceState> {
    await this.updateState(input.clientId, {
      isOpen: true,
      activeCourseId: optionalTrim(input.courseId),
      activeLessonId: optionalTrim(input.lessonId),
      lastCommand: "show_lesson",
      lastCommandId: this.commandId(),
    });
    const synced = await this.syncHyprlandWindow(input.clientId, { arrange: true, waitForWindow: false, uiContext: input.uiContext });
    if (isMissingLearningWindow(synced)) {
      const opened = await this.open(input);
      return this.updateState(input.clientId, {
        lastCommand: "show_lesson",
        lastCommandId: this.commandId(),
        activeCourseId: optionalTrim(input.courseId),
        activeLessonId: optionalTrim(input.lessonId),
        error: opened.error,
        arrangementError: opened.arrangementError,
      });
    }
    return synced;
  }

  async showCourse(input: OpenLearningWorkspaceInput): Promise<LearningWorkspaceState> {
    await this.updateState(input.clientId, {
      isOpen: true,
      activeCourseId: optionalTrim(input.courseId),
      activeLessonId: optionalTrim(input.lessonId),
      lastCommand: "show_course",
      lastCommandId: this.commandId(),
    });
    const synced = await this.syncHyprlandWindow(input.clientId, { arrange: true, waitForWindow: false, uiContext: input.uiContext });
    if (isMissingLearningWindow(synced)) {
      const opened = await this.open(input);
      return this.updateState(input.clientId, {
        lastCommand: "show_course",
        lastCommandId: this.commandId(),
        activeCourseId: optionalTrim(input.courseId),
        activeLessonId: optionalTrim(input.lessonId),
        error: opened.error,
        arrangementError: opened.arrangementError,
      });
    }
    return synced;
  }

  async close(clientId: string): Promise<LearningWorkspaceState> {
    if (this.isChildAlive()) {
      this.child?.kill();
      this.child = null;
    }
    return this.updateState(clientId, {
      isOpen: false,
      launchStatus: "not_started",
      processId: undefined,
      windowVisible: false,
      windowAddress: undefined,
      terminalAddress: undefined,
      arrangementStatus: "not_attempted",
      lastCommand: "close",
      lastCommandId: this.commandId(),
    });
  }

  async getState(clientId = "local"): Promise<LearningWorkspaceState> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8")) as unknown;
      return normalizeState(raw, clientId, this.nowIso());
    } catch {
      return this.defaultState(clientId);
    }
  }

  private launchProcess(input: OpenLearningWorkspaceInput): ChildProcess {
    const configured = process.env["AYATI_LEARNING_UI_COMMAND"]?.trim();
    const env = {
      ...process.env,
      AYATI_LEARNING_API_BASE: this.httpBaseUrl,
      AYATI_LEARNING_INITIAL_COURSE_ID: optionalTrim(input.courseId) ?? "",
      AYATI_LEARNING_INITIAL_LESSON_ID: optionalTrim(input.lessonId) ?? "",
    };

    if (configured) {
      const child = this.spawnImpl(configured, [], {
        cwd: this.projectRoot,
        env,
        detached: true,
        shell: true,
        stdio: "ignore",
      });
      child.unref();
      return child;
    }

    const child = this.spawnImpl("pnpm", [
      "--dir",
      this.projectRoot,
      "--filter",
      "ayati-learning-ui",
      "run",
      "tauri:dev",
    ], {
      cwd: this.projectRoot,
      env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return child;
  }

  private async syncHyprlandWindow(
    clientId: string,
    options: { arrange: boolean; waitForWindow: boolean; uiContext?: AgentUiContext },
  ): Promise<LearningWorkspaceState> {
    if (!this.hyprlandEnabled) {
      return this.updateState(clientId, {
        windowVisible: false,
        arrangementStatus: "unavailable",
        arrangementError: "Hyprland is not available in this process environment.",
      });
    }

    try {
      const lookup = options.waitForWindow
        ? await this.waitForLearningClient()
        : await this.findLearningClientSnapshot();
      if (!lookup.client) {
        return this.updateState(clientId, {
          windowVisible: false,
          arrangementStatus: "failed",
          arrangementError: "Ayati Learning Workspace Tauri window was not found by Hyprland.",
        });
      }

      const activeWorkspace = await this.readActiveWorkspace();
      let terminal: HyprlandClient | null = null;
      let arrangementStatus: LearningWorkspaceArrangementStatus = "not_attempted";
      let arrangementError: string | undefined;

      if (options.arrange) {
        const arranged = await this.arrangeCurrentWorkspace({
          clientId,
          learningClient: lookup.client,
          clients: lookup.clients,
          activeWorkspace,
          uiContext: options.uiContext,
        });
        terminal = arranged.terminal;
        arrangementStatus = arranged.status;
        arrangementError = arranged.error;
      }

      const refreshed = await this.findLearningClientSnapshot();
      const learningClient = refreshed.client ?? lookup.client;
      const workspace = learningClient.workspace ?? activeWorkspace;
      return this.updateState(clientId, {
        windowVisible: learningClient.visible !== false && learningClient.hidden !== true,
        windowAddress: learningClient.address,
        windowTitle: learningClient.title,
        windowClass: learningClient.className,
        processId: learningClient.pid,
        workspaceId: workspace?.id,
        workspaceName: workspace?.name,
        terminalAddress: terminal?.address,
        placementPolicy: options.uiContext ? "current-agent-cli-window" : "active-workspace",
        anchorWindowAddress: terminal?.address,
        anchorWindowTitle: terminal?.title,
        anchorWindowClass: terminal?.className,
        anchorWorkspaceId: terminal?.workspace?.id ?? workspace?.id,
        anchorWorkspaceName: terminal?.workspace?.name ?? workspace?.name,
        arrangementStatus,
        arrangementError,
      });
    } catch (err) {
      return this.updateState(clientId, {
        windowVisible: false,
        arrangementStatus: "failed",
        arrangementError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async waitForLearningClient(): Promise<{ client: HyprlandClient | null; clients: HyprlandClient[] }> {
    for (let attempt = 0; attempt < this.windowPollAttempts; attempt++) {
      const snapshot = await this.findLearningClientSnapshot();
      if (snapshot.client) {
        return snapshot;
      }
      if (this.windowPollIntervalMs > 0) {
        await delay(this.windowPollIntervalMs);
      }
    }
    return this.findLearningClientSnapshot();
  }

  private async findLearningClientSnapshot(): Promise<{ client: HyprlandClient | null; clients: HyprlandClient[] }> {
    const clients = await this.readClients();
    return {
      clients,
      client: findLearningClient(clients, {
        title: this.windowTitle,
        className: this.windowClass,
      }),
    };
  }

  private async arrangeCurrentWorkspace(input: {
    clientId: string;
    learningClient: HyprlandClient;
    clients: HyprlandClient[];
    activeWorkspace: HyprlandWorkspace | null;
    uiContext?: AgentUiContext;
  }): Promise<{ status: LearningWorkspaceArrangementStatus; terminal: HyprlandClient | null; error?: string }> {
    const anchor = resolveAnchorClient(input.clients, input.uiContext);
    const workspace = anchor?.workspace
      ?? workspaceFromUiContext(input.uiContext)
      ?? input.activeWorkspace
      ?? input.learningClient.workspace
      ?? null;
    if (!workspace?.name || !input.learningClient.address) {
      return {
        status: "failed",
        terminal: null,
        error: "Could not determine active workspace or learning window address.",
      };
    }

    const terminal = anchor ?? findTerminalClient(input.clients, workspace.id);
    try {
      await this.dispatchHyprland("movetoworkspacesilent", `${workspace.name},address:${input.learningClient.address}`);
      if (terminal?.address) {
        await this.dispatchHyprland("movetoworkspacesilent", `${workspace.name},address:${terminal.address}`);
        await this.dispatchHyprland("focuswindow", `address:${terminal.address}`);
      }

      if (this.workspaceOrchestrator) {
        const arranged = await this.workspaceOrchestrator.setLayout({
          clientId: input.clientId,
          uiContext: input.uiContext,
          layout: "30-70",
          primaryAddress: input.learningClient.address,
        });
        await this.dispatchHyprland("focuswindow", `address:${input.learningClient.address}`);
        if (arranged.lastActionStatus === "failed") {
          return {
            status: "failed",
            terminal,
            error: arranged.error ?? arranged.layoutVerification?.reason ?? "Workspace orchestrator could not verify the learning layout.",
          };
        }
        return { status: "arranged", terminal };
      }

      await this.dispatchHyprland("settiled", `address:${input.learningClient.address}`);
      if (terminal?.address) {
        await this.dispatchHyprland("settiled", `address:${terminal.address}`);
      }
      await this.dispatchHyprland("focuswindow", `address:${input.learningClient.address}`);
      return { status: "arranged", terminal };
    } catch (err) {
      return {
        status: "failed",
        terminal,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async readClients(): Promise<HyprlandClient[]> {
    const raw = await this.hyprctl(["clients", "-j"]);
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.flatMap(normalizeHyprlandClient);
  }

  private async readActiveWorkspace(): Promise<HyprlandWorkspace | null> {
    const raw = await this.hyprctl(["activeworkspace", "-j"]);
    return normalizeHyprlandWorkspace(JSON.parse(raw) as unknown);
  }

  private async dispatchHyprland(dispatcher: string, args: string): Promise<void> {
    await this.hyprctl(["dispatch", dispatcher, args]);
  }

  private async dispatchHyprlandOptional(dispatcher: string, args: string): Promise<void> {
    try {
      await this.dispatchHyprland(dispatcher, args);
    } catch {
      return;
    }
  }

  private async updateState(
    clientId: string,
    patch: Partial<Omit<LearningWorkspaceState, "schemaVersion" | "clientId" | "lastUpdatedAt">>,
  ): Promise<LearningWorkspaceState> {
    const current = existsSync(this.statePath)
      ? await this.getState(clientId)
      : this.defaultState(clientId);
    const next: LearningWorkspaceState = {
      ...current,
      ...patch,
      schemaVersion: 1,
      clientId: clientId.trim() || "local",
      lastUpdatedAt: this.nowIso(),
    };
    await writeJsonAtomic(this.statePath, next);
    return next;
  }

  private defaultState(clientId: string): LearningWorkspaceState {
    return {
      schemaVersion: 1,
      clientId: clientId.trim() || "local",
      isOpen: false,
      launchStatus: "not_started",
      lastUpdatedAt: this.nowIso(),
    };
  }

  private isChildAlive(): boolean {
    return !!this.child && this.child.exitCode === null && !this.child.killed;
  }

  private launchCommandLabel(): string {
    return process.env["AYATI_LEARNING_UI_COMMAND"]?.trim()
      || "pnpm --filter ayati-learning-ui run tauri:dev";
  }

  private commandId(): string {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function normalizeState(raw: unknown, clientId: string, fallbackUpdatedAt: string): LearningWorkspaceState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Invalid learning workspace state.");
  }
  const record = raw as Record<string, unknown>;
  const launchStatus = record["launchStatus"] === "starting"
    || record["launchStatus"] === "running"
    || record["launchStatus"] === "failed"
    || record["launchStatus"] === "not_started"
    ? record["launchStatus"]
    : "not_started";
  const lastCommand = record["lastCommand"] === "open"
    || record["lastCommand"] === "focus"
    || record["lastCommand"] === "show_lesson"
    || record["lastCommand"] === "show_course"
    || record["lastCommand"] === "close"
    ? record["lastCommand"]
    : undefined;
  const arrangementStatus = record["arrangementStatus"] === "arranged"
    || record["arrangementStatus"] === "unavailable"
    || record["arrangementStatus"] === "failed"
    || record["arrangementStatus"] === "not_attempted"
    ? record["arrangementStatus"]
    : undefined;
  return {
    schemaVersion: 1,
    clientId: typeof record["clientId"] === "string" ? record["clientId"] : clientId,
    isOpen: typeof record["isOpen"] === "boolean" ? record["isOpen"] : false,
    launchStatus,
    ...(typeof record["windowVisible"] === "boolean" ? { windowVisible: record["windowVisible"] } : {}),
    ...(typeof record["windowAddress"] === "string" ? { windowAddress: record["windowAddress"] } : {}),
    ...(typeof record["windowTitle"] === "string" ? { windowTitle: record["windowTitle"] } : {}),
    ...(typeof record["windowClass"] === "string" ? { windowClass: record["windowClass"] } : {}),
    ...(typeof record["workspaceId"] === "number" ? { workspaceId: record["workspaceId"] } : {}),
    ...(typeof record["workspaceName"] === "string" ? { workspaceName: record["workspaceName"] } : {}),
    ...(typeof record["terminalAddress"] === "string" ? { terminalAddress: record["terminalAddress"] } : {}),
    ...(isPlacementPolicy(record["placementPolicy"]) ? { placementPolicy: record["placementPolicy"] } : {}),
    ...(typeof record["anchorWindowAddress"] === "string" ? { anchorWindowAddress: record["anchorWindowAddress"] } : {}),
    ...(typeof record["anchorWindowTitle"] === "string" ? { anchorWindowTitle: record["anchorWindowTitle"] } : {}),
    ...(typeof record["anchorWindowClass"] === "string" ? { anchorWindowClass: record["anchorWindowClass"] } : {}),
    ...(typeof record["anchorWorkspaceId"] === "number" ? { anchorWorkspaceId: record["anchorWorkspaceId"] } : {}),
    ...(typeof record["anchorWorkspaceName"] === "string" ? { anchorWorkspaceName: record["anchorWorkspaceName"] } : {}),
    ...(arrangementStatus ? { arrangementStatus } : {}),
    ...(typeof record["activeCourseId"] === "string" && record["activeCourseId"].trim() ? { activeCourseId: record["activeCourseId"].trim() } : {}),
    ...(typeof record["activeLessonId"] === "string" && record["activeLessonId"].trim() ? { activeLessonId: record["activeLessonId"].trim() } : {}),
    ...(lastCommand ? { lastCommand } : {}),
    ...(typeof record["lastCommandId"] === "string" ? { lastCommandId: record["lastCommandId"] } : {}),
    ...(typeof record["lastOpenedAt"] === "string" ? { lastOpenedAt: record["lastOpenedAt"] } : {}),
    ...(typeof record["lastFocusedAt"] === "string" ? { lastFocusedAt: record["lastFocusedAt"] } : {}),
    lastUpdatedAt: typeof record["lastUpdatedAt"] === "string" ? record["lastUpdatedAt"] : fallbackUpdatedAt,
    ...(typeof record["launchCommand"] === "string" ? { launchCommand: record["launchCommand"] } : {}),
    ...(typeof record["processId"] === "number" ? { processId: record["processId"] } : {}),
    ...(typeof record["error"] === "string" ? { error: record["error"] } : {}),
    ...(typeof record["arrangementError"] === "string" ? { arrangementError: record["arrangementError"] } : {}),
  };
}

interface HyprlandClient {
  address?: string;
  title?: string;
  className?: string;
  initialClassName?: string;
  pid?: number;
  visible?: boolean;
  hidden?: boolean;
  floating?: boolean;
  workspace?: HyprlandWorkspace;
  focusHistoryID?: number;
}

interface HyprlandWorkspace {
  id?: number;
  name?: string;
}

const execFileAsync = promisify(execFile);

const BROWSER_CLASSES = new Set([
  "brave-browser",
  "chromium",
  "firefox",
  "google-chrome",
  "microsoft-edge",
  "vivaldi",
]);

const TERMINAL_CLASSES = new Set([
  "alacritty",
  "foot",
  "ghostty",
  "kitty",
  "org.wezfurlong.wezterm",
  "wezterm",
]);

async function defaultHyprctlRunner(args: string[]): Promise<string> {
  const result = await execFileAsync("hyprctl", args, { encoding: "utf8" });
  return String(result.stdout);
}

function normalizeHyprlandClient(raw: unknown): HyprlandClient[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const record = raw as Record<string, unknown>;
  const workspace = normalizeHyprlandWorkspace(record["workspace"]);
  return [{
    ...(typeof record["address"] === "string" ? { address: record["address"] } : {}),
    ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
    ...(typeof record["class"] === "string" ? { className: record["class"] } : {}),
    ...(typeof record["initialClass"] === "string" ? { initialClassName: record["initialClass"] } : {}),
    ...(typeof record["pid"] === "number" ? { pid: record["pid"] } : {}),
    ...(typeof record["visible"] === "boolean" ? { visible: record["visible"] } : {}),
    ...(typeof record["hidden"] === "boolean" ? { hidden: record["hidden"] } : {}),
    ...(typeof record["floating"] === "boolean" ? { floating: record["floating"] } : {}),
    ...(typeof record["focusHistoryID"] === "number" ? { focusHistoryID: record["focusHistoryID"] } : {}),
    ...(workspace ? { workspace } : {}),
  }];
}

function normalizeHyprlandWorkspace(raw: unknown): HyprlandWorkspace | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  return {
    ...(typeof record["id"] === "number" ? { id: record["id"] } : {}),
    ...(typeof record["name"] === "string" ? { name: record["name"] } : {}),
  };
}

function findLearningClient(
  clients: HyprlandClient[],
  target: { title: string; className: string },
): HyprlandClient | null {
  const targetTitle = target.title.toLowerCase();
  const targetClass = target.className.toLowerCase();
  const candidates = clients.filter((client) => {
    if (client.hidden === true || isBrowserClient(client)) {
      return false;
    }
    const title = client.title?.toLowerCase() ?? "";
    const className = client.className?.toLowerCase() ?? "";
    const initialClassName = client.initialClassName?.toLowerCase() ?? "";
    return title.includes(targetTitle)
      || className.includes(targetClass)
      || initialClassName.includes(targetClass)
      || className.includes("ayati-learning")
      || initialClassName.includes("ayati-learning");
  });
  return candidates.sort((a, b) => (a.focusHistoryID ?? 9999) - (b.focusHistoryID ?? 9999))[0] ?? null;
}

function findTerminalClient(clients: HyprlandClient[], workspaceId: number | undefined): HyprlandClient | null {
  const candidates = clients.filter((client) => {
    if (client.hidden === true || client.visible === false) {
      return false;
    }
    if (workspaceId !== undefined && client.workspace?.id !== workspaceId) {
      return false;
    }
    const className = client.className?.toLowerCase() ?? "";
    const initialClassName = client.initialClassName?.toLowerCase() ?? "";
    return TERMINAL_CLASSES.has(className) || TERMINAL_CLASSES.has(initialClassName);
  });
  return candidates.sort((a, b) => (a.focusHistoryID ?? 9999) - (b.focusHistoryID ?? 9999))[0] ?? null;
}

function resolveAnchorClient(clients: HyprlandClient[], uiContext: AgentUiContext | undefined): HyprlandClient | null {
  if (!uiContext) {
    return null;
  }
  if (uiContext.windowAddress) {
    const byAddress = clients.find((client) => client.address === uiContext.windowAddress);
    if (byAddress && byAddress.hidden !== true) {
      return byAddress;
    }
  }
  if (uiContext.terminalPid) {
    const byTerminalPid = clients.find((client) => client.pid === uiContext.terminalPid);
    if (byTerminalPid && byTerminalPid.hidden !== true) {
      return byTerminalPid;
    }
  }
  const pidSet = new Set(uiContext.processTreePids ?? []);
  if (pidSet.size > 0) {
    const byTree = clients.find((client) => client.pid !== undefined && pidSet.has(client.pid));
    if (byTree && byTree.hidden !== true) {
      return byTree;
    }
  }
  if (uiContext.workspaceId !== undefined || uiContext.workspaceName) {
    return findTerminalClient(clients, uiContext.workspaceId);
  }
  return null;
}

function workspaceFromUiContext(uiContext: AgentUiContext | undefined): HyprlandWorkspace | null {
  if (!uiContext?.workspaceName && uiContext?.workspaceId === undefined) {
    return null;
  }
  return {
    ...(uiContext.workspaceId !== undefined ? { id: uiContext.workspaceId } : {}),
    ...(uiContext.workspaceName ? { name: uiContext.workspaceName } : {}),
  };
}

function isBrowserClient(client: HyprlandClient): boolean {
  const className = client.className?.toLowerCase() ?? "";
  const initialClassName = client.initialClassName?.toLowerCase() ?? "";
  return BROWSER_CLASSES.has(className) || BROWSER_CLASSES.has(initialClassName);
}

function isPlacementPolicy(value: unknown): value is LearningWorkspacePlacementPolicy {
  return value === "current-agent-cli-window"
    || value === "active-workspace"
    || value === "dedicated-workspace"
    || value === "last-used";
}

function isMissingLearningWindow(state: LearningWorkspaceState): boolean {
  return state.arrangementStatus === "failed"
    && state.windowVisible === false
    && (state.arrangementError?.includes("Tauri window was not found") ?? false);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

function optionalTrim(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
