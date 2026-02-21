import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createId } from "../shared/index.js";

export interface SubTask {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done" | "failed";
  depends_on?: number[];
  notesPath?: string;
}

export interface TaskState {
  taskId: string;
  clientId: string;
  stage: "executing" | "complete";
  goal: string;
  subTasks: SubTask[];
  currentSubTaskId: number;
  createdAt: string;
  updatedAt: string;
}

export interface CompleteSubTaskResult {
  nextSubTaskId: number | null;
  nextSubTaskTitle: string | null;
}

export class TaskStateManager {
  private readonly tasksDir: string;
  private readonly activeTasks = new Map<string, TaskState>(); // clientId → state

  constructor(dataDir: string) {
    this.tasksDir = resolve(dataDir, "tasks");
  }

  async initialize(): Promise<void> {
    if (!existsSync(this.tasksDir)) return;
    const entries = readdirSync(this.tasksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateFile = join(this.tasksDir, entry.name, "state.json");
      if (!existsSync(stateFile)) continue;
      try {
        const raw = readFileSync(stateFile, "utf-8");
        const state = JSON.parse(raw) as TaskState;
        if (state.stage !== "complete") {
          this.activeTasks.set(state.clientId, state);
        }
      } catch {
        // corrupt state file — skip
      }
    }
  }

  createTask(clientId: string, goal: string, subTasks: Array<{ id: number; title: string; depends_on?: number[] }>): TaskState {
    const taskId = createId();
    const taskDir = this.getTaskDir(taskId);
    mkdirSync(join(taskDir, "subtasks"), { recursive: true });

    const state: TaskState = {
      taskId,
      clientId,
      stage: "executing",
      goal,
      subTasks: subTasks.map((st) => ({ ...st, status: "pending" as const })),
      currentSubTaskId: subTasks[0]?.id ?? 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.saveState(state);
    this.activeTasks.set(clientId, state);
    return state;
  }

  getActiveTask(clientId: string): TaskState | null {
    return this.activeTasks.get(clientId) ?? null;
  }

  completeSubTask(clientId: string, taskId: string, subTaskId: number, notesPath?: string): CompleteSubTaskResult {
    const state = this.activeTasks.get(clientId);
    if (!state || state.taskId !== taskId) {
      return { nextSubTaskId: null, nextSubTaskTitle: null };
    }

    const sub = state.subTasks.find((s) => s.id === subTaskId);
    if (sub) {
      sub.status = "done";
      if (notesPath) sub.notesPath = notesPath;
    }

    // Find next pending subtask whose dependencies are all done
    const doneIds = new Set(state.subTasks.filter((s) => s.status === "done").map((s) => s.id));
    const next = state.subTasks.find((s) => {
      if (s.status !== "pending") return false;
      if (!s.depends_on || s.depends_on.length === 0) return true;
      return s.depends_on.every((dep) => doneIds.has(dep));
    });

    if (next) {
      next.status = "in_progress";
      state.currentSubTaskId = next.id;
    }

    state.updatedAt = new Date().toISOString();
    this.saveState(state);
    this.activeTasks.set(clientId, state);

    return {
      nextSubTaskId: next?.id ?? null,
      nextSubTaskTitle: next?.title ?? null,
    };
  }

  finishTask(clientId: string, taskId: string): void {
    const state = this.activeTasks.get(clientId);
    if (!state || state.taskId !== taskId) return;
    state.stage = "complete";
    state.updatedAt = new Date().toISOString();
    this.saveState(state);
    this.activeTasks.delete(clientId);
  }

  getTaskDir(taskId: string): string {
    return resolve(this.tasksDir, taskId);
  }

  getSubTaskNotesPath(taskId: string, subTaskId: number): string {
    return join(this.getTaskDir(taskId), "subtasks", `${subTaskId}-notes.md`);
  }

  private saveState(state: TaskState): void {
    const dir = this.getTaskDir(state.taskId);
    mkdirSync(join(dir, "subtasks"), { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
  }
}
