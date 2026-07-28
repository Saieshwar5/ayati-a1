import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  FinalizeRunResponse,
  PrepareAgentRunResponse,
  ResourceAdmission,
  RunWorkStateInput,
  SelectedWorkstreamForRunResponse,
} from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteContextEngineService } from "../src/services/sqlite-context-engine-service.js";

export const TEST_AT = "2026-07-19T10:00:00+05:30";

export interface WorkstreamServiceFixture {
  root: string;
  databasePath: string;
  database: ContextDatabase;
  service: SqliteContextEngineService;
  prepared: PrepareAgentRunResponse;
  dispose(): Promise<void>;
}

export async function createWorkstreamServiceFixture(
  name: string,
  message = "Create a small verified result.",
  resources?: ResourceAdmission[],
): Promise<WorkstreamServiceFixture> {
  const root = await mkdtemp(join(tmpdir(), `ayati-v9-${name}-`));
  const databasePath = join(root, ".ayati", "context.db");
  const database = await ContextDatabase.open({ path: databasePath });
  const service = new SqliteContextEngineService({
    database,
    rootDirectory: root,
    now: () => TEST_AT,
  });
  const prepared = await service.prepareAgentRun({
    requestId: `REQ-${name}-prepare`,
    timezone: "Asia/Kolkata",
    agentId: "local",
    role: "user",
    content: message,
    ...(resources ? { resources } : {}),
    at: TEST_AT,
  });
  let disposed = false;
  return {
    root,
    databasePath,
    database,
    service,
    prepared,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createBoundWorkstream(
  fixture: WorkstreamServiceFixture,
  input?: {
    title?: string;
    objective?: string;
    requestId?: string;
    initialRequest?: {
      title: string;
      request: string;
      acceptance: string[];
      constraints: string[];
    };
    resources?: Array<{
      resourceId: string;
      role: "input" | "reference" | "primary" | "supporting" | "output" | "deliverable" | "evidence" | "asset";
      access: "read" | "mutate";
      primary?: boolean;
    }>;
  },
): Promise<SelectedWorkstreamForRunResponse> {
  return await fixture.service.createWorkstreamForRun({
    requestId: input?.requestId ?? `REQ-${fixture.prepared.run.runId}-create-workstream`,
    runId: fixture.prepared.run.runId,
    title: input?.title ?? "Example Workstream",
    objective: input?.objective ?? "Create and verify the requested example.",
    ...(input?.initialRequest ? { initialRequest: input.initialRequest } : {}),
    ...(input?.resources ? { resources: input.resources } : {}),
    at: "2026-07-19T10:01:00+05:30",
  });
}

export function workState(overrides: Partial<RunWorkStateInput> = {}): RunWorkStateInput {
  return {
    status: "in_progress",
    summary: "Work is in progress.",
    plan: [],
    importantContext: [],
    nextAction: null,
    ...overrides,
  };
}

export function boundRequestAcceptance(
  fixture: WorkstreamServiceFixture,
): string[] {
  const row = fixture.database.prepare([
    "SELECT q.acceptance_json FROM runs r JOIN workstream_requests q",
    "ON q.workstream_id = r.workstream_id AND q.request_id = r.bound_request_id",
    "WHERE r.run_id = ?",
  ].join(" ")).get(fixture.prepared.run.runId) as {
    acceptance_json: string;
  } | undefined;
  if (!row) throw new Error("Expected the current run's bound request projection.");
  return JSON.parse(row.acceptance_json) as string[];
}

export async function materializeBoundWorkstream(
  fixture: WorkstreamServiceFixture,
): Promise<FinalizeRunResponse> {
  return await fixture.service.finalizeRun({
    requestId: fixture.prepared.run.runId + ":materialize",
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "The initial request remains active.",
    streamSummary: "Initialized the durable workstream notebook.",
    summary: "The initial request remains active.",
    validation: "not_applicable",
    next: "Continue the initial request.",
    workState: workState({ summary: "The initial request remains active." }),
    workstream: {
      completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
      requestEffect: { kind: "none" },
    },
    at: "2026-07-19T10:02:00+05:30",
  });
}
