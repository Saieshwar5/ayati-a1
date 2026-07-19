import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitContextClient } from "../src/client.js";
import type { GitContextObservabilityEvent } from "../src/observability.js";
import {
  startGitContextServerRuntime,
  type GitContextServerRuntime,
} from "../src/server-runtime.js";

describe("Git Context server runtime", () => {
  const runtimes: GitContextServerRuntime[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(async (runtime) => await runtime.stop()));
  });

  it("owns the database writer lock and serves over a Unix socket", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-git-context-runtime-"));
    const databasePath = join(root, "store", "context.sqlite");
    const socketPath = join(root, "run", "context.sock");
    const events: GitContextObservabilityEvent[] = [];
    const runtime = await startGitContextServerRuntime({
      databasePath,
      rootDirectory: root,
      socketPath,
      observabilitySink: (event) => events.push(event),
    });
    runtimes.push(runtime);

    const client = new GitContextClient({ connection: { socketPath } });
    await expect(client.getHealth()).resolves.toMatchObject({ ready: true });
    await expect(access(socketPath)).resolves.toBeUndefined();
    await expect(access(databasePath + ".writer-lock/owner.json")).resolves.toBeUndefined();

    await expect(startGitContextServerRuntime({
      databasePath,
      rootDirectory: root,
      socketPath: join(root, "run", "other.sock"),
    })).rejects.toThrow(/live writer/);

    await runtime.stop();
    runtimes.splice(runtimes.indexOf(runtime), 1);
    await expect(access(socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(databasePath + ".writer-lock")).rejects.toMatchObject({ code: "ENOENT" });
    expect(events.map((event) => event.event)).toEqual(expect.arrayContaining([
      "process_starting",
      "writer_lock_acquired",
      "http_request_completed",
      "shutdown_completed",
    ]));
  });

  it("restarts against the same version-5 catalog without conflicting startup idempotency", async () => {
    const root = await mkdtemp(join(tmpdir(), "ayati-git-context-restart-"));
    const databasePath = join(root, "store", "context.sqlite");
    const first = await startGitContextServerRuntime({
      databasePath,
      rootDirectory: root,
      socketPath: join(root, "run", "first.sock"),
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    runtimes.push(first);
    await first.stop();
    runtimes.splice(runtimes.indexOf(first), 1);

    const restarted = await startGitContextServerRuntime({
      databasePath,
      rootDirectory: root,
      socketPath: join(root, "run", "second.sock"),
      timezone: "Asia/Kolkata",
      agentId: "local",
    });
    runtimes.push(restarted);

    const client = new GitContextClient({ connection: restarted.address });
    await expect(client.getHealth()).resolves.toMatchObject({
      protocolVersion: 36,
      ready: true,
    });
  });
});
