import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EpisodicMemoryJob, EpisodicSessionIndexPayload } from "./types.js";

const DEFAULT_DATA_DIR = resolve(process.cwd(), "data", "memory", "episodic");

export interface EpisodicMemoryJobStoreOptions {
  dataDir?: string;
  jobsFileName?: string;
}

interface JobsFile {
  v: 1;
  jobs: EpisodicMemoryJob[];
}

export class EpisodicMemoryJobStore {
  private readonly jobsPath: string;

  constructor(options?: EpisodicMemoryJobStoreOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.jobsPath = resolve(dataDir, options?.jobsFileName ?? "jobs.json");
  }

  enqueueSession(payload: EpisodicSessionIndexPayload, nowIso = new Date().toISOString()): EpisodicMemoryJob {
    const file = this.readFile();
    const jobId = buildSessionJobId(payload.clientId, payload.sessionId);
    const existingIndex = file.jobs.findIndex((job) => job.jobId === jobId);
    const existing = existingIndex >= 0 ? file.jobs[existingIndex] : null;
    const job: EpisodicMemoryJob = {
      jobId,
      jobType: "index_session",
      clientId: payload.clientId,
      sessionId: payload.sessionId,
      sessionPath: payload.sessionPath,
      sessionFilePath: payload.sessionFilePath,
      reason: payload.reason,
      handoffSummary: payload.handoffSummary ?? null,
      status: existing?.status === "done" ? "done" : "pending",
      attempts: existing?.attempts ?? 0,
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
      lastError: existing?.status === "done" ? existing.lastError ?? null : null,
    };

    if (existingIndex >= 0) {
      file.jobs[existingIndex] = job;
    } else {
      file.jobs.push(job);
    }
    this.writeFile(file);
    return job;
  }

  requeueRunning(nowIso = new Date().toISOString()): void {
    const file = this.readFile();
    let changed = false;
    for (const job of file.jobs) {
      if (job.status !== "running") {
        continue;
      }
      job.status = "pending";
      job.updatedAt = nowIso;
      changed = true;
    }
    if (changed) {
      this.writeFile(file);
    }
  }

  claimNextPending(): EpisodicMemoryJob | null {
    const file = this.readFile();
    const job = file.jobs
      .filter((candidate) => candidate.status === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) {
      return null;
    }

    const idx = file.jobs.findIndex((candidate) => candidate.jobId === job.jobId);
    if (idx < 0) {
      return null;
    }

    const nowIso = new Date().toISOString();
    const next: EpisodicMemoryJob = {
      ...file.jobs[idx]!,
      status: "running",
      attempts: file.jobs[idx]!.attempts + 1,
      updatedAt: nowIso,
    };
    file.jobs[idx] = next;
    this.writeFile(file);
    return next;
  }

  markDone(jobId: string, nowIso = new Date().toISOString()): void {
    this.updateJob(jobId, (job) => ({
      ...job,
      status: "done",
      updatedAt: nowIso,
      lastError: null,
    }));
  }

  markFailed(jobId: string, error: string, nowIso = new Date().toISOString()): void {
    this.updateJob(jobId, (job) => ({
      ...job,
      status: "failed",
      updatedAt: nowIso,
      lastError: error,
    }));
  }

  counts(): { pending: number; running: number; failed: number; done: number } {
    const counts = { pending: 0, running: 0, failed: 0, done: 0 };
    for (const job of this.readFile().jobs) {
      counts[job.status]++;
    }
    return counts;
  }

  list(): EpisodicMemoryJob[] {
    return [...this.readFile().jobs];
  }

  private updateJob(jobId: string, updater: (job: EpisodicMemoryJob) => EpisodicMemoryJob): void {
    const file = this.readFile();
    const idx = file.jobs.findIndex((job) => job.jobId === jobId);
    if (idx < 0) {
      return;
    }
    file.jobs[idx] = updater(file.jobs[idx]!);
    this.writeFile(file);
  }

  private readFile(): JobsFile {
    if (!existsSync(this.jobsPath)) {
      return { v: 1, jobs: [] };
    }

    try {
      const parsed = JSON.parse(readFileSync(this.jobsPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return { v: 1, jobs: [] };
      }
      const value = parsed as Partial<JobsFile>;
      if (value.v !== 1 || !Array.isArray(value.jobs)) {
        return { v: 1, jobs: [] };
      }
      return { v: 1, jobs: value.jobs.filter(isJob) };
    } catch {
      return { v: 1, jobs: [] };
    }
  }

  private writeFile(file: JobsFile): void {
    mkdirSync(dirname(this.jobsPath), { recursive: true });
    writeFileSync(this.jobsPath, JSON.stringify(file, null, 2), "utf8");
  }
}

function buildSessionJobId(clientId: string, sessionId: string): string {
  return `index_session:${createHash("sha256").update(`${clientId}:${sessionId}`).digest("hex").slice(0, 24)}`;
}

function isJob(value: unknown): value is EpisodicMemoryJob {
  if (!value || typeof value !== "object") {
    return false;
  }
  const row = value as Record<string, unknown>;
  return (
    typeof row["jobId"] === "string"
    && row["jobType"] === "index_session"
    && typeof row["clientId"] === "string"
    && typeof row["sessionId"] === "string"
    && typeof row["sessionPath"] === "string"
    && typeof row["sessionFilePath"] === "string"
    && typeof row["reason"] === "string"
    && ["pending", "running", "done", "failed"].includes(String(row["status"]))
    && typeof row["attempts"] === "number"
    && typeof row["createdAt"] === "string"
    && typeof row["updatedAt"] === "string"
  );
}
