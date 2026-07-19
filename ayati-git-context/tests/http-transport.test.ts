import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type AcquireMutationAuthorityRequest,
  type AcquireMutationAuthorityResponse,
} from "../src/contracts.js";
import { ContractOnlyGitContextService } from "../src/contract-only-service.js";
import { GitContextClient } from "../src/client.js";
import { ContextDatabase } from "../src/database/database.js";
import {
  GitContextObserver,
  type GitContextObservabilityEvent,
} from "../src/observability.js";
import {
  GitContextHttpServer,
  type GitContextServerAddress,
} from "../src/server.js";
import type { GitContextService } from "../src/service.js";
import { SqliteGitContextService } from "../src/services/sqlite-git-context-service.js";

const servers: GitContextHttpServer[] = [];
const services: SqliteGitContextService[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await server.stop()));
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("Git Context protocol 34 HTTP transport", () => {
  it("round-trips atomic preparation, one step, and one finalization over TCP", async () => {
    const service = await createService();
    const { client } = await startTcpServer(service);

    await expect(client.getHealth()).resolves.toMatchObject({
      service: "ayati-git-context",
      protocolVersion: GIT_CONTEXT_PROTOCOL_VERSION,
      ready: true,
      capabilities: expect.arrayContaining(["runs", "tasks", "mutations", "recovery"]),
    });
    const prepared = await client.prepareContextTurn({
      requestId: "REQ-http-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Inspect the requirements.",
      at: "2026-07-19T12:00:00+05:30",
    });
    expect(prepared).toMatchObject({
      sessionCreated: true,
      message: { role: "user", content: "Inspect the requirements." },
      run: {
        sessionId: prepared.session.sessionId,
        conversationId: prepared.conversation.conversationId,
      },
      persistence: {
        database: "saved",
        materialization: "not_requested",
        git: "not_committed",
      },
    });
    const step = await client.recordRunStep({
      requestId: prepared.run.runId + ":step:1",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "completed",
        summary: "Read the requirements.",
        toolCalls: [{
          callId: "call-http-read",
          tool: "read_files",
          purpose: "Read the current requirements.",
          toolPurpose: "read",
          toolEffect: "read_only",
          status: "success",
          input: { paths: ["requirements.md"] },
          output: { files: [{ path: "requirements.md" }] },
        }],
        verification: { passed: true },
        workStateAfter: { ...workState(), summary: "Requirements inspected." },
        createdAt: "2026-07-19T12:00:01+05:30",
      },
    });
    expect(step).toMatchObject({
      run: { run: { runId: prepared.run.runId, stepCount: 1 } },
      readContext: { evidence: [{ callId: "call-http-read" }] },
    });
    const finalized = await client.finalizeRun({
      requestId: prepared.run.runId + ":finalize",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      outcome: "done",
      stopReason: "completed",
      assistantResponse: "I inspected the requirements.",
      conversationSummary: "The user asked for a requirements inspection.",
      summary: "Requirements inspected.",
      validation: "not_applicable",
      workState: { ...workState(), status: "done", summary: "Requirements inspected." },
      at: "2026-07-19T12:00:02+05:30",
    });
    expect(finalized).toMatchObject({
      run: { status: "done", stopReason: "completed", stepCount: 1 },
      conversation: { status: "closed" },
      materialization: { status: "materialized" },
      commit: { status: "not_required" },
    });
  });

  it("round-trips same-run task creation without allocating another run", async () => {
    const service = await createService();
    const { client } = await startTcpServer(service);
    const prepared = await client.prepareContextTurn({
      requestId: "REQ-http-task-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Create one durable task.",
      at: "2026-07-19T12:00:00+05:30",
    });

    const selected = await client.createTaskForRun({
      requestId: "REQ-http-task-create",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      runId: prepared.run.runId,
      title: "HTTP task",
      objective: "Prove task binding over the protocol boundary.",
      placement: { mode: "managed" },
      at: "2026-07-19T12:00:01+05:30",
    });

    expect(selected).toMatchObject({
      run: {
        runId: prepared.run.runId,
        taskBinding: {
          taskId: selected.task.taskId,
          taskRequestId: "R-0001",
        },
      },
      taskCreated: true,
      taskRequestDecision: "initial",
    });
  });

  it("propagates request, session, and run correlation into transport events", async () => {
    const events: GitContextObservabilityEvent[] = [];
    const service = await createService();
    const { client } = await startTcpServer(
      service,
      new GitContextObserver("git-context-http", (event) => events.push(event)),
    );
    const prepared = await client.prepareContextTurn({
      requestId: "REQ-http-correlated-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Record a correlated step.",
      at: "2026-07-19T12:00:00+05:30",
    });
    await client.recordRunStep({
      requestId: "REQ-http-correlated-step",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      record: {
        version: 1,
        step: 1,
        status: "failed",
        summary: "Routing did not find a task.",
        toolCalls: [{
          callId: "call-route",
          tool: "git_context_activate_task",
          purpose: "Route to an existing task.",
          toolPurpose: "control",
          toolEffect: "context_mutation",
          status: "failed",
          input: { taskId: "T-missing" },
          error: { code: "TASK_NOT_FOUND" },
        }],
        verification: { passed: false },
        workStateAfter: workState(),
        createdAt: "2026-07-19T12:00:01+05:30",
      },
    });

    expect(events.filter((event) =>
      event.requestId === "REQ-http-correlated-step"
      && (event.event === "http_request_started" || event.event === "http_request_completed")
    )).toEqual([
      expect.objectContaining({
        event: "http_request_started",
        sessionId: prepared.session.sessionId,
        runId: prepared.run.runId,
      }),
      expect.objectContaining({
        event: "http_request_completed",
        sessionId: prepared.session.sessionId,
        runId: prepared.run.runId,
      }),
    ]);
  });

  it("uses structured service errors", async () => {
    const { client } = await startTcpServer(new ContractOnlyGitContextService());
    await expect(client.prepareContextTurn({
      requestId: "REQ-not-ready",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Hello.",
      at: "2026-07-19T12:00:00+05:30",
    })).rejects.toMatchObject({
      name: "GitContextServiceError",
      code: "SERVICE_NOT_READY",
      retryable: false,
    });
  });

  it("accepts zero-target task-bound authority through the HTTP boundary", async () => {
    const { client } = await startTcpServer(new ZeroTargetAuthorityService());
    await expect(client.acquireMutationAuthority({
      requestId: "REQ-zero-target-authority",
      sessionId: "S-20260719-local",
      runId: "R-20260719-0001",
      taskId: "T-20260719-0001",
      taskRequestId: "R-0001",
      expectedTaskHead: "a".repeat(40),
      targets: [],
      at: "2026-07-19T12:00:00+05:30",
    })).resolves.toMatchObject({
      authority: {
        runId: "R-20260719-0001",
        taskId: "T-20260719-0001",
        taskRequestId: "R-0001",
        targets: [],
      },
    });
  });

  it("rejects invalid bodies and supports Unix socket clients", async () => {
    const service = await createService();
    const { address } = await startTcpServer(service);
    if (address.kind !== "tcp") throw new Error("Expected TCP address.");
    const response = await sendRawJson(address, "/context/turns/prepare", {
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    expect(response).toMatchObject({
      statusCode: 400,
      body: { error: { code: "INVALID_REQUEST" } },
    });

    const root = await mkdtemp(join(tmpdir(), "ayati-http-unix-"));
    roots.push(root);
    const socketPath = join(root, "context.sock");
    const unix = new GitContextHttpServer({ service, listen: { socketPath } });
    servers.push(unix);
    await unix.start();
    const client = new GitContextClient({ connection: { socketPath } });
    await expect(client.getHealth()).resolves.toMatchObject({ ready: true });
    await unix.stop();
    servers.splice(servers.indexOf(unix), 1);
    await expect(rm(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class ZeroTargetAuthorityService extends ContractOnlyGitContextService {
  override async acquireMutationAuthority(
    input: AcquireMutationAuthorityRequest,
  ): Promise<AcquireMutationAuthorityResponse> {
    return {
      authority: {
        authorityId: input.runId + "-M-0001",
        lockToken: "test-token",
        sessionId: input.sessionId,
        runId: input.runId,
        taskId: input.taskId,
        taskRequestId: input.taskRequestId,
        repositoryPath: "/tmp/tasks/" + input.taskId,
        branch: "main",
        beforeHead: input.expectedTaskHead ?? "a".repeat(40),
        targets: [],
        status: "active",
        expiresAt: "2026-07-19T12:15:00+05:30",
      },
    };
  }
}

async function createService(): Promise<SqliteGitContextService> {
  const root = await mkdtemp(join(tmpdir(), "ayati-http-transport-"));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const service = new SqliteGitContextService({
    database,
    dataRoot: join(root, "session-data"),
    workspaceRoot: join(root, "workspace"),
    now: () => "2026-07-19T12:00:00+05:30",
  });
  services.push(service);
  return service;
}

function workState() {
  return {
    status: "not_done" as const,
    summary: "Run is active.",
    openWork: [],
    blockers: [],
    facts: [],
    evidence: [],
    artifacts: [],
    nextStep: null,
    userInputNeeded: [],
  };
}

async function startTcpServer(
  service: GitContextService,
  observer?: GitContextObserver,
): Promise<{
  server: GitContextHttpServer;
  address: GitContextServerAddress;
  client: GitContextClient;
}> {
  const server = new GitContextHttpServer({
    service,
    listen: { host: "127.0.0.1", port: 0 },
    ...(observer ? { observer } : {}),
  });
  servers.push(server);
  const address = await server.start();
  if (address.kind !== "tcp") throw new Error("Expected TCP server address.");
  return {
    server,
    address,
    client: new GitContextClient({
      connection: { host: "127.0.0.1", port: address.port },
    }),
  };
}

function sendRawJson(
  address: Extract<GitContextServerAddress, { kind: "tcp" }>,
  path: string,
  value: unknown,
): Promise<{ statusCode: number; body: unknown }> {
  const body = JSON.stringify(value);
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: address.port,
      method: "POST",
      path,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolveResponse({
          statusCode: response.statusCode ?? 0,
          body: text ? JSON.parse(text) as unknown : undefined,
        });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
