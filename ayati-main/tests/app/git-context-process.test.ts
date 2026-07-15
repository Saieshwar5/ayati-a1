import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitContextClient,
  startGitContextServerRuntime,
  type GitContextObservabilityEvent,
} from "ayati-git-context";
import {
  startManagedGitContextProcess,
  type ManagedGitContextProcess,
} from "../../src/app/git-context-process.js";
import type { GitContextRuntimeConfig } from "../../src/config/runtime-config.js";

describe("managed Git Context Engine process", () => {
  const processes: ManagedGitContextProcess[] = [];

  afterEach(async () => {
    await Promise.all(processes.splice(0).map(async (process) => await process.stop()));
  });

  it("starts a ready child process and stops it with the daemon lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-managed-context-"));
    const socketPath = join(root, "context.sock");
    const events: GitContextObservabilityEvent[] = [];
    const managed = await startManagedGitContextProcess({
      ...config(root, socketPath),
      onObservabilityEvent: (event) => events.push(event),
    });
    processes.push(managed);

    expect(managed.getStatus()).toMatchObject({
      managed: true,
      running: true,
      generation: 1,
    });
    expect(managed.getStatus().pid).not.toBe(process.pid);
    await expect(managed.getHealth()).resolves.toMatchObject({ ready: true });

    await managed.stop();
    processes.splice(processes.indexOf(managed), 1);
    expect(managed.getStatus().running).toBe(false);
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "child_spawned",
      "server_ready",
      "child_ready",
      "child_shutdown_completed",
    ]));
  });

  it("restarts once after an observed child crash and repeats the same read", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-managed-context-restart-"));
    const events: GitContextObservabilityEvent[] = [];
    const managed = await startManagedGitContextProcess({
      ...config(root, join(root, "context.sock")),
      onObservabilityEvent: (event) => events.push(event),
    });
    processes.push(managed);
    const firstPid = managed.getStatus().pid;
    expect(firstPid).toBeTypeOf("number");

    process.kill(firstPid!, "SIGKILL");
    await waitFor(() => !managed.getStatus().running);

    await expect(managed.getHealth()).resolves.toMatchObject({ ready: true });
    expect(managed.getStatus()).toMatchObject({ running: true, generation: 2 });
    expect(managed.getStatus().pid).not.toBe(firstPid);
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "child_exit_observed",
      "request_retry_after_child_exit",
      "child_restart_started",
      "child_restart_completed",
    ]));
  });

  it("connects to an externally owned server without stopping it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-external-context-"));
    const socketPath = join(root, "context.sock");
    const server = await startGitContextServerRuntime({
      databasePath: join(root, "context.sqlite"),
      dataRoot: join(root, "git-data"),
      socketPath,
    });
    try {
      const external = await startManagedGitContextProcess({
        ...config(root, socketPath),
        managed: false,
      });
      processes.push(external);
      expect(external.getStatus()).toEqual({
        managed: false,
        running: false,
        generation: 0,
      });
      await external.stop();
      processes.splice(processes.indexOf(external), 1);

      const client = new GitContextClient({ connection: { socketPath } });
      await expect(client.getHealth()).resolves.toMatchObject({ ready: true });
    } finally {
      await server.stop();
    }
  });
});

function config(root: string, socketPath: string): GitContextRuntimeConfig {
  return {
    storeDir: root,
    databasePath: join(root, "context.sqlite"),
    dataRoot: join(root, "git-data"),
    workspaceRoot: join(root, "workspace"),
    socketPath,
    managed: true,
    startTimeoutMs: 5_000,
    stopTimeoutMs: 5_000,
    requestTimeoutMs: 2_000,
    timezone: "UTC",
    agentId: "test",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for process state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
