import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SubsessionEndReport,
  SubsessionFailureReport,
  SubsessionLogEvent,
  SubsessionMeta,
  SubsessionPlan,
  SubsessionProgressEvent,
  SubsessionSnapshot,
  SubsessionState,
  SubsessionTask,
  SubsessionTaskVerification,
} from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..");
const DEFAULT_SUBSESSION_ROOT = resolve(projectRoot, "data", "subsessions");
const ACTIVE_LOCK_FILE = "active_subsession.lock";

interface SubsessionPaths {
  root: string;
  metaFile: string;
  contextFile: string;
  planFile: string;
  stateFile: string;
  tasksDir: string;
  verificationDir: string;
  artifactsDir: string;
  checkpointsDir: string;
  progressFile: string;
  logFile: string;
  failureFile: string;
  endFile: string;
  lockFile: string;
}

export interface CreateSubsessionInput {
  clientId: string;
  parentSessionId: string;
  parentRunId: string;
  goalSummary: string;
  maxAttemptsPerTask: number;
  maxTotalSteps: number;
  maxNoProgressCycles: number;
  relatedToSubsessionId?: string;
}

export interface SubsessionStoreOptions {
  rootDir?: string;
  now?: () => Date;
}

function buildDefaultPlan(nowIso: string): SubsessionPlan {
  return {
    goal: "",
    doneCriteria: "",
    constraints: [],
    tasks: [],
    revision: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: "llm",
  };
}

function buildDefaultState(
  nowIso: string,
  maxAttemptsPerTask: number,
  maxTotalSteps: number,
  maxNoProgressCycles: number,
): SubsessionState {
  return {
    currentTaskIndex: 0,
    currentAttempt: 0,
    totalSteps: 0,
    totalToolCalls: 0,
    maxAttemptsPerTask,
    maxTotalSteps,
    maxNoProgressCycles,
    noProgressCycles: 0,
    modeStatus: "created",
    lastCheckpoint: nowIso,
  };
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toNdjson(event: unknown): string {
  return `${JSON.stringify(event)}\n`;
}

export class SubsessionStore {
  private readonly rootDir: string;
  private readonly now: () => Date;

  constructor(options?: SubsessionStoreOptions) {
    this.rootDir = options?.rootDir ?? DEFAULT_SUBSESSION_ROOT;
    this.now = options?.now ?? (() => new Date());
  }

  getRootDir(): string {
    return this.rootDir;
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  async getActiveLock(): Promise<string | null> {
    await this.ensureRoot();
    const lockPath = this.lockPath();
    try {
      const raw = (await readFile(lockPath, "utf8")).trim();
      return raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  }

  async acquireActiveLock(subsessionId: string): Promise<{ ok: true } | { ok: false; activeId: string }> {
    await this.ensureRoot();
    const current = await this.getActiveLock();
    if (current && current !== subsessionId) {
      return { ok: false, activeId: current };
    }
    await writeFile(this.lockPath(), `${subsessionId}\n`, "utf8");
    return { ok: true };
  }

  async releaseActiveLock(subsessionId: string): Promise<void> {
    await this.ensureRoot();
    const lockPath = this.lockPath();
    const current = await this.getActiveLock();
    if (!current || current !== subsessionId) return;
    try {
      await unlink(lockPath);
    } catch {
      return;
    }
  }

  async createSubsession(input: CreateSubsessionInput): Promise<SubsessionSnapshot> {
    await this.ensureRoot();
    const id = randomUUID();
    const nowIso = this.nowIso();
    const paths = this.paths(id);

    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.tasksDir, { recursive: true });
    await mkdir(paths.verificationDir, { recursive: true });
    await mkdir(paths.artifactsDir, { recursive: true });
    await mkdir(paths.checkpointsDir, { recursive: true });

    const meta: SubsessionMeta = {
      id,
      clientId: input.clientId,
      parentSessionId: input.parentSessionId,
      parentRunId: input.parentRunId,
      goalSummary: input.goalSummary,
      status: "created",
      revision: 1,
      relatedToSubsessionId: input.relatedToSubsessionId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    const plan = buildDefaultPlan(nowIso);
    const state = buildDefaultState(
      nowIso,
      input.maxAttemptsPerTask,
      input.maxTotalSteps,
      input.maxNoProgressCycles,
    );

    await writeFile(paths.metaFile, JSON.stringify(meta, null, 2), "utf8");
    await writeFile(paths.planFile, JSON.stringify(plan, null, 2), "utf8");
    await writeFile(paths.stateFile, JSON.stringify(state, null, 2), "utf8");
    await writeFile(paths.contextFile, "", "utf8");
    await writeFile(paths.progressFile, "", "utf8");
    await writeFile(paths.logFile, "", "utf8");

    return { dirPath: paths.root, meta, plan, state };
  }

  async loadSubsession(subsessionId: string): Promise<SubsessionSnapshot | null> {
    const paths = this.paths(subsessionId);
    const [metaRaw, planRaw, stateRaw] = await Promise.all([
      this.readFileOrNull(paths.metaFile),
      this.readFileOrNull(paths.planFile),
      this.readFileOrNull(paths.stateFile),
    ]);

    if (!metaRaw || !planRaw || !stateRaw) return null;
    const meta = parseJson<SubsessionMeta>(metaRaw);
    const plan = parseJson<SubsessionPlan>(planRaw);
    const state = parseJson<SubsessionState>(stateRaw);
    if (!meta || !plan || !state) return null;

    return {
      dirPath: paths.root,
      meta,
      plan,
      state,
    };
  }

  async listMetas(clientId?: string): Promise<SubsessionMeta[]> {
    await this.ensureRoot();
    const entries = await readdir(this.rootDir, { withFileTypes: true });
    const metas: SubsessionMeta[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metaPath = this.paths(entry.name).metaFile;
      const raw = await this.readFileOrNull(metaPath);
      if (!raw) continue;
      const meta = parseJson<SubsessionMeta>(raw);
      if (!meta) continue;
      if (clientId && meta.clientId !== clientId) continue;
      metas.push(meta);
    }

    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async writeContext(subsessionId: string, contextText: string): Promise<void> {
    const paths = this.paths(subsessionId);
    await writeFile(paths.contextFile, contextText, "utf8");
  }

  async saveMeta(meta: SubsessionMeta): Promise<void> {
    const updated: SubsessionMeta = {
      ...meta,
      updatedAt: this.nowIso(),
    };
    const paths = this.paths(meta.id);
    await writeFile(paths.metaFile, JSON.stringify(updated, null, 2), "utf8");
  }

  async savePlan(subsessionId: string, plan: SubsessionPlan): Promise<void> {
    const updated: SubsessionPlan = {
      ...plan,
      updatedAt: this.nowIso(),
    };
    const paths = this.paths(subsessionId);
    await writeFile(paths.planFile, JSON.stringify(updated, null, 2), "utf8");
  }

  async saveState(subsessionId: string, state: SubsessionState): Promise<void> {
    const updated: SubsessionState = {
      ...state,
      lastCheckpoint: this.nowIso(),
    };
    const paths = this.paths(subsessionId);
    await writeFile(paths.stateFile, JSON.stringify(updated, null, 2), "utf8");
  }

  async saveTask(subsessionId: string, task: SubsessionTask): Promise<void> {
    const updated: SubsessionTask = {
      ...task,
      updatedAt: this.nowIso(),
    };
    const filePath = this.taskFilePath(subsessionId, task.id);
    await writeFile(filePath, JSON.stringify(updated, null, 2), "utf8");
  }

  async writeVerification(
    subsessionId: string,
    taskId: string,
    attempt: number,
    verification: SubsessionTaskVerification,
    outputSummary: string,
  ): Promise<string> {
    const fileName = `${taskId}-attempt-${String(attempt).padStart(2, "0")}.json`;
    const paths = this.paths(subsessionId);
    const filePath = resolve(paths.verificationDir, fileName);
    const payload = {
      taskId,
      attempt,
      verification,
      outputSummary,
      createdAt: this.nowIso(),
    };
    await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
    return filePath;
  }

  async appendProgress(subsessionId: string, event: SubsessionProgressEvent): Promise<void> {
    const paths = this.paths(subsessionId);
    await appendFile(paths.progressFile, toNdjson(event), "utf8");
  }

  async appendLog(subsessionId: string, event: SubsessionLogEvent): Promise<void> {
    const paths = this.paths(subsessionId);
    await appendFile(paths.logFile, toNdjson(event), "utf8");
  }

  async writeFailure(subsessionId: string, failure: SubsessionFailureReport): Promise<void> {
    const paths = this.paths(subsessionId);
    await writeFile(paths.failureFile, JSON.stringify(failure, null, 2), "utf8");
  }

  async writeEnd(subsessionId: string, end: SubsessionEndReport): Promise<void> {
    const paths = this.paths(subsessionId);
    await writeFile(paths.endFile, JSON.stringify(end, null, 2), "utf8");
  }

  taskFilePath(subsessionId: string, taskId: string): string {
    return resolve(this.paths(subsessionId).tasksDir, `${taskId}.json`);
  }

  private paths(subsessionId: string): SubsessionPaths {
    const root = resolve(this.rootDir, subsessionId);
    return {
      root,
      metaFile: resolve(root, "meta.json"),
      contextFile: resolve(root, "context.md"),
      planFile: resolve(root, "plan.json"),
      stateFile: resolve(root, "state.json"),
      tasksDir: resolve(root, "tasks"),
      verificationDir: resolve(root, "verification"),
      artifactsDir: resolve(root, "artifacts"),
      checkpointsDir: resolve(root, "checkpoints"),
      progressFile: resolve(root, "progress.ndjson"),
      logFile: resolve(root, "subsession.log.ndjson"),
      failureFile: resolve(root, "failure.json"),
      endFile: resolve(root, "end.json"),
      lockFile: resolve(root, "lock"),
    };
  }

  private lockPath(): string {
    return resolve(this.rootDir, ACTIVE_LOCK_FILE);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async readFileOrNull(filePath: string): Promise<string | null> {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  }
}

