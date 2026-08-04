import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextDatabase } from "../src/database/database.js";
import { ensureAgentStream } from "../src/repositories/agent-stream-records.js";
import { appendStreamMessage } from "../src/repositories/message-records.js";
import { createRun } from "../src/repositories/run-records.js";
import { AgentContextProjectionService } from "../src/services/agent-context-projection-service.js";

const roots: string[] = [];
const databases: ContextDatabase[] = [];
const AT = "2026-08-04T04:36:40.205Z";

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("active-run current input", () => {
  it("reuses the durable ingress message for every context rebuild", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-active-run-input-"));
    roots.push(root);
    const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
    databases.push(database);
    const stream = ensureAgentStream(database, {
      agentId: "local",
      scopeKey: "default",
      at: AT,
    }).stream;
    const run = createRun(database, {
      streamId: stream.streamId,
      trigger: "user",
      workState: {
        status: "in_progress",
        summary: "Run started.",
        plan: [],
        importantContext: [],
        nextAction: null,
      },
      at: AT,
    });
    const currentUserMessage = "Add education qualification to the friends list manager.";
    appendStreamMessage(database, {
      streamId: stream.streamId,
      runId: run.runId,
      role: "user",
      content: currentUserMessage,
      at: AT,
    });

    const firstCandidateLoad = vi.fn(async () => []);
    const firstProjection = new AgentContextProjectionService({
      database,
      loadWorkstreamCandidates: firstCandidateLoad,
    });
    await firstProjection.build({
      streamId: stream.streamId,
      currentText: "A conflicting transient caller value.",
    });

    const rebuiltCandidateLoad = vi.fn(async () => []);
    const rebuiltProjection = new AgentContextProjectionService({
      database,
      loadWorkstreamCandidates: rebuiltCandidateLoad,
    });
    await rebuiltProjection.build({ streamId: stream.streamId });

    expect(firstCandidateLoad).toHaveBeenCalledWith({
      streamId: stream.streamId,
      currentText: currentUserMessage,
    });
    expect(rebuiltCandidateLoad).toHaveBeenCalledWith({
      streamId: stream.streamId,
      currentText: currentUserMessage,
    });
  });
});
