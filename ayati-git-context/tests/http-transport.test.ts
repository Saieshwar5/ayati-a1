import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
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

describe("Git Context protocol 36 HTTP transport", () => {
  it("round-trips atomic preparation, one step, and one finalization over TCP", async () => {
    const service = await createService();
    const { client } = await startTcpServer(service);

    await expect(client.getHealth()).resolves.toMatchObject({
      service: "ayati-git-context",
      protocolVersion: GIT_CONTEXT_PROTOCOL_VERSION,
      ready: true,
      capabilities: expect.arrayContaining(["runs", "workstreams", "mutations", "recovery"]),
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
      resourceEffects: { status: "none", events: [] },
      workstreamContextCommit: { status: "not_required" },
    });
  });

  it("round-trips same-run workstream creation without allocating another run", async () => {
    const service = await createService();
    const { client } = await startTcpServer(service);
    const prepared = await client.prepareContextTurn({
      requestId: "REQ-http-workstream-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Create one durable workstream.",
      at: "2026-07-19T12:00:00+05:30",
    });

    const selected = await client.createWorkstreamForRun({
      requestId: "REQ-http-workstream-create",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      runId: prepared.run.runId,
      title: "HTTP workstream",
      objective: "Prove workstream binding over the protocol boundary.",
      at: "2026-07-19T12:00:01+05:30",
    });

    expect(selected).toMatchObject({
      run: {
        runId: prepared.run.runId,
        workstreamBinding: {
          workstreamId: selected.workstream.workstreamId,
          requestId: "R-0001",
        },
      },
      workstreamCreated: true,
      workstreamRequestDecision: "initial",
    });
  });

  it("round-trips filesystem resource inspection without binding the run", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-http-location-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const directory = join(workspaceRoot, "existing-work");
    await mkdir(directory, { recursive: true });
    const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
    const service = new SqliteGitContextService({
      database,
      rootDirectory: root,
      now: () => "2026-07-19T12:00:00+05:30",
    });
    services.push(service);
    const { client } = await startTcpServer(service);
    const prepared = await client.prepareContextTurn({
      requestId: "REQ-http-location-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Use this existing directory.",
      at: "2026-07-19T12:00:00+05:30",
    });

    const inspected = await client.inspectResourceForRun({
      requestId: "REQ-http-resource-inspect",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      locator: { kind: "filesystem", path: directory },
      kind: "directory",
      origin: "user_reference",
      displayName: "existing-work",
      description: "Existing user work referenced for this turn.",
      aliases: ["existing project"],
      at: "2026-07-19T12:00:01+05:30",
    });

    expect(inspected).toMatchObject({
      existing: false,
      mutationEligible: true,
      resource: {
        kind: "directory",
        locator: { kind: "filesystem", path: directory },
        availability: "available",
      },
    });
    expect((await client.getActiveContext({ sessionId: prepared.session.sessionId }))
      .run?.run.workstreamBinding).toBeUndefined();
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
        summary: "Routing did not find a workstream.",
        toolCalls: [{
          callId: "call-route",
          tool: "git_context_activate_workstream",
          purpose: "Route to an existing workstream.",
          toolPurpose: "control",
          toolEffect: "context_mutation",
          status: "failed",
          input: { workstreamId: "W-missing" },
          error: { code: "WORKSTREAM_NOT_FOUND" },
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

  it("round-trips exact resource mutation preparation and verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-http-mutation-"));
    roots.push(root);
    const resourceRoot = join(root, "real-output");
    await mkdir(resourceRoot);
    const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
    const service = new SqliteGitContextService({
      database,
      rootDirectory: root,
      now: () => "2026-07-19T12:00:00+05:30",
    });
    services.push(service);
    const { client } = await startTcpServer(service);
    const prepared = await client.prepareContextTurn({
      requestId: "REQ-http-mutation-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Create one verified output file.",
      at: "2026-07-19T12:00:00+05:30",
    });
    const inspected = await client.inspectResourceForRun({
      requestId: "REQ-http-mutation-inspect",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      locator: { kind: "filesystem", path: resourceRoot },
      kind: "directory",
      origin: "user_reference",
      at: "2026-07-19T12:00:01+05:30",
    });
    const selected = await client.createWorkstreamForRun({
      requestId: "REQ-http-mutation-create",
      sessionId: prepared.session.sessionId,
      conversationId: prepared.conversation.conversationId,
      runId: prepared.run.runId,
      title: "HTTP Mutation",
      objective: "Verify a resource mutation across the transport boundary.",
      resources: [{
        resourceId: inspected.resource.resourceId,
        role: "primary",
        access: "mutate",
        primary: true,
      }],
      at: "2026-07-19T12:00:02+05:30",
    });
    const binding = selected.run.workstreamBinding;
    if (!binding) throw new Error("Expected workstream binding.");
    const mutation = await client.prepareResourceMutation({
      requestId: "REQ-http-mutation-authorize",
      sessionId: prepared.session.sessionId,
      runId: prepared.run.runId,
      workstreamId: binding.workstreamId,
      activeRequestId: binding.requestId,
      callId: "call-http-write",
      tool: "write_files",
      effect: "workspace_mutation",
      targets: [{
        resourceId: inspected.resource.resourceId,
        relativePath: "output.txt",
        kind: "file",
        expectedVersionKey: inspected.resource.version.key,
      }],
      at: "2026-07-19T12:00:03+05:30",
    });
    await writeFile(join(resourceRoot, "output.txt"), "verified output\n");

    await expect(client.verifyResourceMutation({
      requestId: "REQ-http-mutation-verify",
      operationId: mutation.operationId,
      leaseId: mutation.leaseId,
      lockToken: mutation.lockToken,
      toolStatus: "completed",
      at: "2026-07-19T12:00:04+05:30",
    })).resolves.toMatchObject({
      status: "verified",
      verified: true,
      events: [{ resourceId: inspected.resource.resourceId, type: "modified" }],
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

async function createService(): Promise<SqliteGitContextService> {
  const root = await mkdtemp(join(tmpdir(), "ayati-http-transport-"));
  roots.push(root);
  const database = await ContextDatabase.open({ path: join(root, "context.sqlite") });
  const service = new SqliteGitContextService({
    database,
    rootDirectory: root,
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
