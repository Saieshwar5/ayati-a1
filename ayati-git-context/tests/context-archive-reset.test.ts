import { spawn } from "node:child_process";
import { createServer, type Server } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../scripts/context-archive-reset.mjs", import.meta.url),
);
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    if (!server.listening) return;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  }));
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("context archive reset", () => {
  it("prints resolved targets without changing state when confirmation is absent", async () => {
    const fixture = await createFixture();
    await createRuntimeState(fixture);

    const result = await runArchiveReset(fixture.env);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain(`database: ${fixture.databasePath}`);
    expect(result.stdout).toContain(`session-data: ${fixture.sessionRoot}`);
    expect(result.stdout).toContain(`resource-root: ${fixture.resourceRoot}`);
    expect(result.stdout).toContain(`workstream-root: ${fixture.workstreamRoot}`);
    expect(result.stdout).toContain(`workspace: ${fixture.workspaceRoot} (preserved)`);
    expect(result.stdout).toContain("No files were changed.");
    await expect(access(fixture.databasePath)).resolves.toBeUndefined();
    await expect(access(join(fixture.sessionRoot, "session.json"))).resolves.toBeUndefined();
    await expect(access(join(fixture.resourceRoot, "blob"))).resolves.toBeUndefined();
    await expect(access(join(fixture.workstreamRoot, "workstream.json"))).resolves.toBeUndefined();
    await expect(access(join(fixture.workspaceRoot, "deliverable.txt"))).resolves.toBeUndefined();
    expect((await readdir(fixture.parentRoot)).filter((name) => name.startsWith("ayati-root-archive-")))
      .toEqual([]);
  });

  it("archives the database sidecars, session data, and workstream root with a manifest", async () => {
    const fixture = await createFixture();
    await createRuntimeState(fixture);

    const result = await runArchiveReset(fixture.env, ["--confirm"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const archiveRoot = result.stdout.trim().replace("Archived Git Context state to ", "");
    expect(dirname(archiveRoot)).toBe(fixture.parentRoot);
    await expect(access(fixture.databasePath)).rejects.toThrow();
    await expect(access(fixture.sessionRoot)).rejects.toThrow();
    await expect(access(fixture.resourceRoot)).rejects.toThrow();
    await expect(access(fixture.workstreamRoot)).rejects.toThrow();
    await expect(access(join(fixture.workspaceRoot, "deliverable.txt"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "database", "context.sqlite"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "database", "context.sqlite-wal"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "database", "context.sqlite-shm"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "sessions", "session.json"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "resources", "blob"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "workstreams", "workstream.json"))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(archiveRoot, "manifest.json"), "utf8")))
      .toMatchObject({
        version: 2,
        operation: "context_archive_reset",
        status: "completed",
        preservedPaths: [fixture.workspaceRoot],
        entries: [
          { label: "database", archived: true },
          { label: "database-wal", archived: true },
          { label: "database-shm", archived: true },
          { label: "session-data", archived: true },
          { label: "resource-root", archived: true },
          { label: "workstream-root", archived: true },
        ],
      });
  });

  it("rejects removed compatibility switches instead of silently changing archive scope", async () => {
    const fixture = await createFixture();
    await createRuntimeState(fixture);

    const result = await runArchiveReset(fixture.env, [
      "--confirm",
      "--preserve-workstream-repositories",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown context archive reset option");
    await expect(access(fixture.databasePath)).resolves.toBeUndefined();
    await expect(access(fixture.sessionRoot)).resolves.toBeUndefined();
    await expect(access(join(fixture.workstreamRoot, "workstream.json"))).resolves.toBeUndefined();
  });

  it("refuses a broad database directory before creating an archive", async () => {
    const fixture = await createFixture();

    const result = await runArchiveReset({
      ...fixture.env,
      AYATI_GIT_CONTEXT_DATABASE: "/context.sqlite",
    }, ["--confirm"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Refusing to archive unsafe database parent: /");
    expect((await readdir(fixture.parentRoot)).filter((name) => name.startsWith("ayati-root-archive-")))
      .toEqual([]);
  });

  it("refuses to archive while the configured Unix socket is live", async () => {
    const fixture = await createFixture();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(fixture.socketPath, resolveListen);
    });

    const result = await runArchiveReset(fixture.env, ["--confirm"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `Refusing to archive while the Git Context socket is live: ${fixture.socketPath}`,
    );
    expect((await readdir(fixture.parentRoot)).filter((name) => name.startsWith("ayati-root-archive-")))
      .toEqual([]);
  });
});

interface ArchiveFixture {
  databasePath: string;
  env: NodeJS.ProcessEnv;
  parentRoot: string;
  resourceRoot: string;
  sessionRoot: string;
  socketPath: string;
  workspaceRoot: string;
  workstreamRoot: string;
}

async function createFixture(): Promise<ArchiveFixture> {
  const parentRoot = await mkdtemp(join(tmpdir(), "ayati-context-archive-reset-"));
  roots.push(parentRoot);
  const root = join(parentRoot, "ayati-root");
  const workspaceRoot = join(root, "workspace");
  const stateRoot = join(root, ".ayati");
  const databasePath = join(stateRoot, "context.sqlite");
  const socketPath = join(stateRoot, "git-context.sock");
  await mkdir(stateRoot, { recursive: true });
  return {
    databasePath,
    parentRoot,
    resourceRoot: join(stateRoot, "resources"),
    sessionRoot: join(stateRoot, "sessions"),
    socketPath,
    workspaceRoot,
    workstreamRoot: join(root, "workstreams"),
    env: {
      ...process.env,
      AYATI_ROOT_DIR: root,
      AYATI_GIT_CONTEXT_DATABASE: databasePath,
      AYATI_GIT_CONTEXT_SOCKET: socketPath,
    },
  };
}

async function createRuntimeState(fixture: ArchiveFixture): Promise<void> {
  await mkdir(fixture.sessionRoot, { recursive: true });
  await mkdir(fixture.resourceRoot, { recursive: true });
  await mkdir(fixture.workstreamRoot, { recursive: true });
  await mkdir(fixture.workspaceRoot, { recursive: true });
  await Promise.all([
    writeFile(fixture.databasePath, "database", "utf8"),
    writeFile(fixture.databasePath + "-wal", "wal", "utf8"),
    writeFile(fixture.databasePath + "-shm", "shm", "utf8"),
    writeFile(join(fixture.sessionRoot, "session.json"), "session", "utf8"),
    writeFile(join(fixture.resourceRoot, "blob"), "resource", "utf8"),
    writeFile(join(fixture.workstreamRoot, "workstream.json"), "workstream", "utf8"),
    writeFile(join(fixture.workspaceRoot, "deliverable.txt"), "keep", "utf8"),
  ]);
}

function runArchiveReset(
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", rejectRun);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}
