import { spawnSync } from "node:child_process";
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("../../scripts/context-archive-reset.mjs", import.meta.url),
);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("context archive reset", () => {
  it("previews the reset without changing state when confirmation is absent", async () => {
    const fixture = await createFixture();
    await createRuntimeState(fixture);

    const result = await runArchiveReset(fixture.env);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    await expect(access(fixture.databasePath)).resolves.toBeUndefined();
    await expect(access(join(fixture.resourceRoot, "blob"))).resolves.toBeUndefined();
    await expect(access(join(fixture.workstreamRoot, "workstream.json"))).resolves.toBeUndefined();
    await expect(access(join(fixture.workspaceRoot, "deliverable.txt"))).resolves.toBeUndefined();
    expect((await readdir(fixture.parentRoot)).filter((name) => name.startsWith("ayati-root-archive-")))
      .toEqual([]);
  });

  it("archives the V5 database, resources, and workstreams with a V7 reset manifest", async () => {
    const fixture = await createFixture();
    await createRuntimeState(fixture);

    const result = await runArchiveReset(fixture.env, ["--confirm"]);

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const archiveNames = (await readdir(fixture.parentRoot))
      .filter((name) => name.startsWith("ayati-root-archive-"));
    expect(archiveNames).toHaveLength(1);
    const archiveRoot = join(fixture.parentRoot, archiveNames[0] ?? "missing-archive");
    await expect(access(fixture.databasePath)).rejects.toThrow();
    await expect(access(fixture.resourceRoot)).rejects.toThrow();
    await expect(access(fixture.workstreamRoot)).rejects.toThrow();
    await expect(access(join(fixture.workspaceRoot, "deliverable.txt"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "database", "context.sqlite"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "database", "context.sqlite-wal"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "database", "context.sqlite-shm"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "resources", "blob"))).resolves.toBeUndefined();
    await expect(access(join(archiveRoot, "workstreams", "workstream.json"))).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(join(archiveRoot, "manifest.json"), "utf8")))
      .toMatchObject({
        version: 3,
        archivedSchemaVersion: 5,
        nextSchemaVersion: 6,
        operation: "context_archive_reset",
        status: "completed",
        preservedPaths: [fixture.workspaceRoot],
        entries: [
          { label: "database", archived: true },
          { label: "database-wal", archived: true },
          { label: "database-shm", archived: true },
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
    await expect(access(join(fixture.workstreamRoot, "workstream.json"))).resolves.toBeUndefined();
  });

  it("refuses a broad database directory before creating an archive", async () => {
    const fixture = await createFixture();

    const result = await runArchiveReset({
      ...fixture.env,
      AYATI_CONTEXT_ENGINE_DATABASE: "/context.sqlite",
    }, ["--confirm"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Refusing to archive unsafe database parent: /");
    expect((await readdir(fixture.parentRoot)).filter((name) => name.startsWith("ayati-root-archive-")))
      .toEqual([]);
  });

  it("refuses to archive while the database writer owner is live", async () => {
    const fixture = await createFixture();
    const writerLock = fixture.databasePath + ".writer-lock";
    await mkdir(writerLock, { recursive: true });
    await writeFile(join(writerLock, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8");

    const result = await runArchiveReset(fixture.env, ["--confirm"]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      `Refusing to archive while Context Engine writer PID ${process.pid} is live.`,
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
  await mkdir(stateRoot, { recursive: true });
  return {
    databasePath,
    parentRoot,
    resourceRoot: join(stateRoot, "resources"),
    workspaceRoot,
    workstreamRoot: join(root, "workstreams"),
    env: {
      ...process.env,
      AYATI_ROOT_DIR: root,
      AYATI_CONTEXT_ENGINE_DATABASE: databasePath,
    },
  };
}

async function createRuntimeState(fixture: ArchiveFixture): Promise<void> {
  await mkdir(fixture.resourceRoot, { recursive: true });
  await mkdir(fixture.workstreamRoot, { recursive: true });
  await mkdir(fixture.workspaceRoot, { recursive: true });
  await Promise.all([
    writeFile(fixture.databasePath, "database", "utf8"),
    writeFile(fixture.databasePath + "-wal", "wal", "utf8"),
    writeFile(fixture.databasePath + "-shm", "shm", "utf8"),
    writeFile(join(fixture.resourceRoot, "blob"), "resource", "utf8"),
    writeFile(join(fixture.workstreamRoot, "workstream.json"), "workstream", "utf8"),
    writeFile(join(fixture.workspaceRoot, "deliverable.txt"), "keep", "utf8"),
  ]);
}

function runArchiveReset(
  env: NodeJS.ProcessEnv,
  args: string[] = [],
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  return {
    code: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
