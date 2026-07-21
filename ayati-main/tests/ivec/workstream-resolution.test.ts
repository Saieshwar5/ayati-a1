import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContextDatabase,
  SqliteContextEngineService,
} from "ayati-context-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmProvider } from "../../src/core/contracts/provider.js";
import type { LlmTurnInput, LlmTurnOutput } from "../../src/core/contracts/llm-protocol.js";
import { reduceResolutionWorkState } from "../../src/ivec/workstream-resolution/reducer.js";
import { createWorkstreamResolutionCoordinator } from "../../src/ivec/workstream-resolution/runner.js";
import type { ResolutionWorkState } from "../../src/ivec/workstream-resolution/types.js";

const roots: string[] = [];
const services: SqliteContextEngineService[] = [];
const AT = "2026-07-21T10:00:00.000Z";

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

describe("isolated workstream resolver", () => {
  it("searches, creates one accurate request, and keeps its journal out of main run state", async () => {
    const fixture = await createFixture("create", "Implement isolated workstream resolution.");
    const provider = queuedProvider([
      toolCalls([{
        id: "search-1",
        name: "resolution_search_workstreams",
        input: { query: "isolated workstream resolution" },
      }]),
      toolCalls([{
        id: "create-1",
        name: "resolution_create_workstream",
        input: {
          title: "Isolated workstream resolution",
          objective: "Resolve one workstream without mutating the main execution loop.",
          initialRequest: {
            title: "Implement the isolated resolver",
            request: "Implement a bounded resolver and mount its selected workstream context.",
            acceptance: ["Resolver steps remain outside the main run journal."],
            constraints: ["Bind exactly one workstream and request."],
          },
          resources: [],
          evidence: ["Authoritative catalog search returned no owning workstream."],
        },
      }]),
    ]);
    const coordinator = createWorkstreamResolutionCoordinator({
      provider: provider.provider,
      service: fixture.service,
      runId: fixture.prepared.run.runId,
      streamId: fixture.prepared.stream.streamId,
      currentInput: fixture.prepared.message.content,
      inputContextRevision: fixture.prepared.context.contextRevision,
      now: () => new Date(AT),
    });

    const outcome = await coordinator.resolve({
      purpose: "Resolve the durable owner for implementing the isolated resolver.",
      hints: [{ kind: "filesystem", path: "/workspace/isolated-resolver" }],
    });

    expect(outcome.receipt).toMatchObject({
      status: "resolved",
      resolutionKind: "created_workstream",
      requestId: "R-0001",
      stepCount: 2,
    });
    expect(outcome.context.current.routing).toMatchObject({
      status: "bound",
      requestId: "R-0001",
    });
    expect(provider.generateTurn).toHaveBeenCalledTimes(2);

    const activityId = outcome.receipt.activityId;
    const journal = await fixture.service.getWorkstreamResolution({ activityId });
    const context = await fixture.service.getAgentContext({ streamId: fixture.prepared.stream.streamId });
    expect(journal.steps.map((step) => step.toolCalls.map((call) => call.tool))).toEqual([
      ["resolution_search_workstreams"],
      ["resolution_create_workstream"],
    ]);
    expect(journal.activity).toMatchObject({
      status: "resolved",
      stepCount: 2,
      toolCallCount: 2,
    });
    expect(context).toMatchObject({
      activeWorkstream: {
        title: "Isolated workstream resolution",
        currentRequest: {
          title: "Implement the isolated resolver",
          request: "Implement a bounded resolver and mount its selected workstream context.",
          acceptance: ["Resolver steps remain outside the main run journal."],
        },
      },
      run: {
        run: { stepCount: 0 },
        workState: { revision: 0, afterStep: 0 },
        steps: [],
      },
    });

    const firstTurn = provider.generateTurn.mock.calls[0]![0] as LlmTurnInput;
    const ownerSchema = firstTurn.tools?.find((tool) => tool.name === "resolution_find_resource_owners");
    const createSchema = firstTurn.tools?.find((tool) => tool.name === "resolution_create_workstream");
    expect(firstTurn.toolChoice).toBe("required");
    expect(firstTurn.parallelToolCalls).toBe(true);
    expect(firstTurn.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("/workspace/isolated-resolver"),
      }),
    ]));
    expect(ownerSchema?.inputSchema).toHaveProperty("properties.resourceIds");
    expect(createSchema?.inputSchema).toHaveProperty("properties.resources");
  });

  it("publishes compact ambiguity metadata and leaves the run unbound", async () => {
    const fixture = await createFixture("ambiguity", "Continue the project.");
    const provider = queuedProvider([toolCalls([{
      id: "clarify-1",
      name: "resolution_needs_user_input",
      input: {
        reasonCodes: ["missing_project_identity"],
        question: "Which project should I continue?",
        candidateIds: [],
      },
    }])]);
    const coordinator = createCoordinator(fixture, provider.provider);

    const outcome = await coordinator.resolve({
      purpose: "Resolve which project owns this continuation request.",
      hints: [],
    });

    expect(outcome.receipt).toMatchObject({
      status: "needs_user_input",
      candidateCount: 0,
      stepCount: 1,
    });
    expect(outcome.context.current.routing).toEqual({ status: "clarifying" });
    expect(outcome.context.workstreamResolution?.result).toMatchObject({
      status: "needs_user_input",
      question: "Which project should I continue?",
      reasonCodes: ["missing_project_identity"],
    });
    const context = await fixture.service.getAgentContext({ streamId: fixture.prepared.stream.streamId });
    expect(context.run?.run.workstreamBinding).toBeUndefined();
    expect(context.run?.steps).toEqual([]);
  });

  it("preserves provider order for parallel private reads and records every detail", async () => {
    const fixture = await createFixture("parallel", "Find the owner of this work.");
    const provider = queuedProvider([
      toolCalls([
        {
          id: "search-first",
          name: "resolution_search_workstreams",
          input: { query: "owner of this work" },
        },
        {
          id: "owners-second",
          name: "resolution_find_resource_owners",
          input: { query: "owner of this work" },
        },
      ]),
      toolCalls([{
        id: "clarify-last",
        name: "resolution_needs_user_input",
        input: {
          reasonCodes: ["no_authoritative_owner"],
          question: "What project or path should this work use?",
          candidateIds: [],
        },
      }]),
    ]);
    const coordinator = createCoordinator(fixture, provider.provider);

    const outcome = await coordinator.resolve({
      purpose: "Find the authoritative owner.",
      hints: [],
    });
    const journal = await fixture.service.getWorkstreamResolution({ activityId: outcome.receipt.activityId });

    expect(journal.steps[0]?.toolCalls.map((call) => call.id)).toEqual([
      "search-first",
      "owners-second",
    ]);
    expect(journal.steps[0]?.decision).toEqual({
      calls: [
        {
          id: "search-first",
          tool: "resolution_search_workstreams",
          input: { query: "owner of this work" },
        },
        {
          id: "owners-second",
          tool: "resolution_find_resource_owners",
          input: { query: "owner of this work" },
        },
      ],
    });
    expect(journal.activity).toMatchObject({ stepCount: 2, toolCallCount: 3 });
  });

  it("fails safely after two invalid resolver decisions", async () => {
    const fixture = await createFixture("limit", "Resolve this task.");
    const provider = queuedProvider([
      { type: "assistant", content: "I should search." },
      { type: "assistant", content: "I should still search." },
    ]);
    const coordinator = createCoordinator(fixture, provider.provider);

    const outcome = await coordinator.resolve({ purpose: "Resolve the task owner.", hints: [] });

    expect(outcome.receipt).toMatchObject({
      status: "failed",
      code: "WORKSTREAM_RESOLUTION_REPEATED_FAILURE",
      stepCount: 2,
    });
    const context = await fixture.service.getAgentContext({ streamId: fixture.prepared.stream.streamId });
    expect(context.run?.run.workstreamBinding).toBeUndefined();
    expect(context.run?.steps).toEqual([]);
  });

  it("rejects a model-invented direct-read id before it reaches the context service", async () => {
    const fixture = await createFixture("invented-read", "Continue this task.");
    const readWorkstream = vi.spyOn(fixture.service, "readWorkstream");
    const provider = queuedProvider([
      toolCalls([{
        id: "invented-read",
        name: "resolution_read_workstreams",
        input: { workstreamIds: ["W-20260721-9999"] },
      }]),
      toolCalls([{
        id: "clarify-after-invalid-read",
        name: "resolution_needs_user_input",
        input: {
          reasonCodes: ["no_authoritative_candidate"],
          question: "Which workstream or project should I continue?",
          candidateIds: [],
        },
      }]),
    ]);
    const coordinator = createCoordinator(fixture, provider.provider);

    const outcome = await coordinator.resolve({ purpose: "Resolve the task owner.", hints: [] });
    const journal = await fixture.service.getWorkstreamResolution({
      activityId: outcome.receipt.activityId,
    });

    expect(outcome.receipt.status).toBe("needs_user_input");
    expect(readWorkstream).not.toHaveBeenCalled();
    expect(journal.steps[0]).toMatchObject({
      status: "failed",
      toolCalls: [{
        tool: "resolution_read_workstreams",
        status: "failed",
        error: {
          code: "RESOLUTION_TOOL_INPUT_INVALID",
          retryable: false,
        },
      }],
    });
  });

  it("hydrates an authoritative candidate from a direct workstream read", () => {
    const initial: ResolutionWorkState = {
      status: "searching",
      purpose: "Continue the exact hinted workstream.",
      searches: [],
      candidates: [],
      resourceOwnership: [],
      failures: [],
    };

    const next = reduceResolutionWorkState(initial, [{
      id: "read-exact",
      tool: "resolution_read_workstreams",
      input: { workstreamIds: ["W-0042"] },
      status: "completed",
      output: {
        workstreams: [{
          status: "completed",
          workstreamId: "W-0042",
          workstream: {
            workstreamId: "W-0042",
            contextRepositoryPath: "/context/W-0042",
            branch: "workstreams/W-0042",
            head: "abc123",
            title: "Exact workstream",
            objective: "Continue the exact durable owner.",
            status: "active",
            createdAt: AT,
            updatedAt: AT,
          },
          context: {
            lifecycleStatus: "active",
            repositoryHealth: "ready",
            currentRequest: {
              id: "R-0007",
              title: "Continue exact request",
              status: "active",
              request: "Continue the exact request.",
              acceptance: [],
              constraints: [],
            },
            resources: [],
          },
          opened: true,
        }],
      },
    }]);

    expect(next.status).toBe("inspecting");
    expect(next.candidates).toEqual([expect.objectContaining({
      inspected: true,
      possibleRequestIds: ["R-0007"],
      candidate: expect.objectContaining({
        workstreamId: "W-0042",
        head: "abc123",
        currentRequest: {
          id: "R-0007",
          title: "Continue exact request",
          status: "active",
        },
        discovery: {
          tier: "definite",
          reasons: ["exact_workstream_id"],
        },
      }),
    })]);
  });
});

async function createFixture(name: string, content: string) {
  const root = await mkdtemp(join(tmpdir(), `ayati-main-resolution-${name}-`));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const service = new SqliteContextEngineService({
    database,
    rootDirectory: root,
    now: () => AT,
  });
  services.push(service);
  const prepared = await service.prepareAgentRun({
    requestId: `prepare:${name}`,
    timezone: "Asia/Kolkata",
    agentId: "local",
    scopeKey: "default",
    role: "user",
    content,
    at: AT,
  });
  return { service, prepared };
}

function createCoordinator(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  provider: LlmProvider,
) {
  return createWorkstreamResolutionCoordinator({
    provider,
    service: fixture.service,
    runId: fixture.prepared.run.runId,
    streamId: fixture.prepared.stream.streamId,
    currentInput: fixture.prepared.message.content,
    inputContextRevision: fixture.prepared.context.contextRevision,
    now: () => new Date(AT),
  });
}

function queuedProvider(outputs: LlmTurnOutput[]): {
  provider: LlmProvider;
  generateTurn: ReturnType<typeof vi.fn>;
} {
  let index = 0;
  const generateTurn = vi.fn(async () => {
    const output = outputs[index++];
    if (!output) throw new Error("No queued resolver response.");
    return output;
  });
  return {
    provider: {
      name: "resolver-test",
      version: "test-model",
      capabilities: { nativeToolCalling: true },
      start() {},
      stop() {},
      generateTurn,
    },
    generateTurn,
  };
}

function toolCalls(calls: Array<{
  id: string;
  name: string;
  input: Record<string, unknown>;
}>): LlmTurnOutput {
  return { type: "tool_calls", calls };
}
