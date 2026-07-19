import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PrepareContextTurnResponse,
  ResourceAdmission,
  RunWorkStateInput,
  SelectedWorkstreamForRunResponse,
} from "../src/contracts.js";
import { ContextDatabase } from "../src/database/database.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

export const TEST_AT = "2026-07-19T10:00:00+05:30";

export interface WorkstreamServiceFixture {
  root: string;
  databasePath: string;
  database: ContextDatabase;
  service: SqliteGitContextService;
  prepared: PrepareContextTurnResponse;
  dispose(): Promise<void>;
}

export async function createWorkstreamServiceFixture(
  name: string,
  message = "Create a small verified result.",
  resources?: ResourceAdmission[],
): Promise<WorkstreamServiceFixture> {
  const root = await mkdtemp(join(tmpdir(), `ayati-v4-${name}-`));
  const databasePath = join(root, ".ayati", "context.db");
  const database = await ContextDatabase.open({ path: databasePath });
  const service = new SqliteGitContextService({
    database,
    rootDirectory: root,
    now: () => TEST_AT,
  });
  const prepared = await service.prepareContextTurn({
    requestId: `REQ-${name}-prepare`,
    date: "2026-07-19",
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
    sessionId: fixture.prepared.session.sessionId,
    conversationId: fixture.prepared.conversation.conversationId,
    runId: fixture.prepared.run.runId,
    title: input?.title ?? "Example Workstream",
    objective: input?.objective ?? "Create and verify the requested example.",
    ...(input?.resources ? { resources: input.resources } : {}),
    at: "2026-07-19T10:01:00+05:30",
  });
}

export function workState(overrides: Partial<RunWorkStateInput> = {}): RunWorkStateInput {
  return {
    status: "not_done",
    summary: "Work is in progress.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
    ...overrides,
  };
}
