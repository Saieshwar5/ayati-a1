import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

export async function createBoundWorkstreamWithMutableDirectory(
  fixture: WorkstreamServiceFixture,
  input?: Parameters<typeof createBoundWorkstream>[1],
): Promise<SelectedWorkstreamForRunResponse> {
  const outputPath = join(fixture.root, "workspace", "explicit-test-output");
  await mkdir(outputPath, { recursive: true });
  const inspected = await fixture.service.inspectResourceForRun({
    requestId: `REQ-${fixture.prepared.run.runId}-inspect-output`,
    runId: fixture.prepared.run.runId,
    locator: { kind: "filesystem", path: outputPath },
    kind: "directory",
    origin: "agent_discovered",
    displayName: "explicit-test-output",
    description: "Explicit mutable output directory for this test.",
    aliases: [input?.title ?? "test output", "primary output"],
    at: "2026-07-19T10:00:30+05:30",
  });
  return await createBoundWorkstream(fixture, {
    ...input,
    resources: [{
      resourceId: inspected.resource.resourceId,
      role: "primary",
      access: "mutate",
      primary: true,
    }],
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
  const binding = fixture.database.prepare([
    "SELECT workstream_id, bound_request_id FROM runs WHERE run_id = ?",
  ].join(" ")).get(fixture.prepared.run.runId) as {
    workstream_id: string;
    bound_request_id: string;
  } | undefined;
  if (!binding?.workstream_id || !binding.bound_request_id) {
    throw new Error("Expected a workstream-bound fixture run.");
  }
  const existing = fixture.database.prepare(
    "SELECT 1 AS present FROM workstream_resources WHERE workstream_id = ? LIMIT 1",
  ).get(binding.workstream_id);
  if (!existing) {
    const resourcePath = join(
      fixture.root,
      "workspace",
      "materialized-" + binding.workstream_id.toLowerCase(),
    );
    await mkdir(resourcePath, { recursive: true });
    const inspected = await fixture.service.inspectResourceForRun({
      requestId: fixture.prepared.run.runId + ":materialize-resource:inspect",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path: resourcePath },
      kind: "directory",
      origin: "agent_discovered",
      displayName: "materialized workstream resource",
      description: "Durable test resource required to retain the workstream.",
      aliases: ["test resource"],
      at: "2026-07-19T10:01:30+05:30",
    });
    await fixture.service.bindResourcesForRun({
      requestId: fixture.prepared.run.runId + ":materialize-resource:bind",
      runId: fixture.prepared.run.runId,
      workstreamId: binding.workstream_id,
      bindings: [{
        resourceId: inspected.resource.resourceId,
        role: "primary",
        access: "mutate",
        primary: true,
      }],
      at: "2026-07-19T10:01:31+05:30",
    });
  }
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
