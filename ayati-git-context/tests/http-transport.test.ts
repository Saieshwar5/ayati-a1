import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GIT_CONTEXT_PROTOCOL_VERSION,
  type ActiveContext,
  type AppendConversationRequest,
  type AppendConversationResponse,
  type EnsureActiveSessionRequest,
  type EnsureActiveSessionResponse,
  type GetActiveContextRequest,
  type HealthResponse,
  type RecordRunStepRequest,
  type RecordRunStepResponse,
  type StartRunRequest,
  type StartRunResponse,
} from "../src/contracts.js";
import { ContractOnlyGitContextService } from "../src/contract-only-service.js";
import { GitContextClient } from "../src/client.js";
import {
  GitContextHttpServer,
  type GitContextServerAddress,
} from "../src/server.js";
import type { GitContextService } from "../src/service.js";

const servers: GitContextHttpServer[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await server.stop();
  }));
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { recursive: true, force: true });
  }));
});

describe("Git Context Engine HTTP transport", () => {
  it("round-trips the initial service operations over TCP", async () => {
    const service = new TestGitContextService();
    const { client } = await startTcpServer(service);

    await expect(client.getHealth()).resolves.toEqual({
      service: "ayati-git-context",
      protocolVersion: GIT_CONTEXT_PROTOCOL_VERSION,
      status: "ok",
      ready: true,
      capabilities: ["health", "active_context", "sessions", "conversations", "runs"],
    });

    const ensured = await client.ensureActiveSession({
      requestId: "REQ-1",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    expect(ensured.created).toBe(true);
    expect(ensured.session.sessionId).toBe("S-20260712-local");

    const appended = await client.appendConversation({
      requestId: "REQ-2",
      sessionId: ensured.session.sessionId,
      role: "user",
      content: "hello",
      at: "2026-07-12T10:00:00+05:30",
    });
    expect(appended.conversation.conversationId).toBe("C-000001");

    const started = await client.startRun({
      requestId: "REQ-3",
      sessionId: ensured.session.sessionId,
      conversationId: appended.conversation.conversationId,
      trigger: "user",
    });
    expect(started.run).toMatchObject({
      runId: "R-20260712-0001",
      runClass: "session",
    });
    await expect(client.recordRunStep({
      requestId: "REQ-4",
      sessionId: ensured.session.sessionId,
      runId: started.run.runId,
      step: 1,
      tool: "read_files",
      purpose: "Inspect the current files.",
      status: "completed",
      at: "2026-07-12T10:00:01+05:30",
    })).resolves.toEqual({
      toolCall: {
        step: 1,
        tool: "read_files",
        purpose: "Inspect the current files.",
        status: "completed",
      },
    });

    const context = await client.getActiveContext({
      sessionId: ensured.session.sessionId,
    });
    expect(context.session?.session.sessionId).toBe(ensured.session.sessionId);
    expect(service.activeContextRequests).toEqual([
      { sessionId: ensured.session.sessionId },
    ]);
  });

  it("uses structured service errors", async () => {
    const { client } = await startTcpServer(new ContractOnlyGitContextService());

    await expect(client.ensureActiveSession({
      requestId: "REQ-1",
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
    })).rejects.toMatchObject({
      name: "GitContextServiceError",
      code: "SERVICE_NOT_READY",
      retryable: false,
    });
  });

  it("rejects invalid request bodies at the transport boundary", async () => {
    const { address } = await startTcpServer(new TestGitContextService());
    if (address.kind !== "tcp") {
      throw new Error("Expected TCP address.");
    }

    const response = await sendRawJson(address, "/sessions/ensure-active", {
      date: "2026-07-12",
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "INVALID_REQUEST",
      },
    });
  });

  it("supports Unix socket clients and removes its socket on stop", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ayati-git-context-test-"));
    temporaryDirectories.push(directory);
    const socketPath = join(directory, "engine.sock");
    const server = new GitContextHttpServer({
      service: new TestGitContextService(),
      listen: { socketPath },
    });
    servers.push(server);
    await server.start();

    const client = new GitContextClient({
      connection: { socketPath },
    });
    await expect(client.getHealth()).resolves.toMatchObject({
      service: "ayati-git-context",
      ready: true,
    });

    await server.stop();
    servers.splice(servers.indexOf(server), 1);
    await expect(rm(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

class TestGitContextService implements GitContextService {
  readonly activeContextRequests: GetActiveContextRequest[] = [];
  private session: EnsureActiveSessionResponse["session"] | null = null;

  async getHealth(): Promise<HealthResponse> {
    return {
      service: "ayati-git-context",
      protocolVersion: GIT_CONTEXT_PROTOCOL_VERSION,
      status: "ok",
      ready: true,
      capabilities: ["health", "active_context", "sessions", "conversations", "runs"],
    };
  }

  async getActiveContext(input: GetActiveContextRequest): Promise<ActiveContext> {
    this.activeContextRequests.push(input);
    return {
      session: this.session
        ? {
            session: this.session,
            summary: "",
            pendingConversation: [],
            pendingConversationContext: [],
            pendingDigest: "sha256:empty",
            recentCommits: [],
          }
        : null,
      warnings: [],
    };
  }

  async ensureActiveSession(
    input: EnsureActiveSessionRequest,
  ): Promise<EnsureActiveSessionResponse> {
    this.session = {
      sessionId: "S-" + input.date.replaceAll("-", "") + "-" + input.agentId,
      repositoryPath: "/tmp/session",
      head: null,
      date: input.date,
      timezone: input.timezone,
      status: "open",
    };
    return {
      session: this.session,
      created: true,
    };
  }

  async appendConversation(
    input: AppendConversationRequest,
  ): Promise<AppendConversationResponse> {
    return {
      conversation: {
        conversationId: "C-000001",
        sessionId: input.sessionId,
        sequence: 1,
        filePath: "conversations/000001.pending.md",
        status: "active",
      },
    };
  }

  async startRun(input: StartRunRequest): Promise<StartRunResponse> {
    return {
      run: {
        runId: "R-20260712-0001",
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        runClass: "session",
      },
    };
  }

  async recordRunStep(input: RecordRunStepRequest): Promise<RecordRunStepResponse> {
    return {
      toolCall: {
        step: input.step,
        tool: input.tool,
        purpose: input.purpose,
        status: input.status,
      },
    };
  }
}

async function startTcpServer(service: GitContextService): Promise<{
  server: GitContextHttpServer;
  address: GitContextServerAddress;
  client: GitContextClient;
}> {
  const server = new GitContextHttpServer({
    service,
    listen: { host: "127.0.0.1", port: 0 },
  });
  servers.push(server);
  const address = await server.start();
  if (address.kind !== "tcp") {
    throw new Error("Expected TCP server address.");
  }
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
  return new Promise((resolve, reject) => {
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
      response.on("data", (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode ?? 500,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
