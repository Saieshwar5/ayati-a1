import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FinalizeRunRequest,
  VerifiedFilesystemResourceEffect,
} from "../src/contracts.js";
import { parseWorkstreamCommit } from "../src/workstreams/workstream-commit-metadata.js";
import { validateWorkstreamRepository } from "../src/workstreams/workstream-repository-validator.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("verified filesystem resource effect finalization", () => {
  it("records a verified created file even when the larger request remains incomplete", async () => {
    const fixture = await createFixture("incomplete-create");
    const selected = await createBoundWorkstream(fixture, {
      title: "Incomplete Website",
      objective: "Keep verified physical progress across runs.",
    });
    const path = join(fixture.root, "workspace", "site", "index.html");
    await mkdir(join(fixture.root, "workspace", "site"), { recursive: true });
    await writeFile(path, "<h1>In progress</h1>\n", "utf8");

    const finalized = await fixture.service.finalizeRun(incompleteFinalization(fixture, [
      unaryEffect("FRE-000000000000000000000001", "created", path, 1, "write-index"),
    ]));

    const row = fixture.database.prepare([
      "SELECT resource_id, origin, locator_json, metadata_status, availability",
      "FROM resources",
    ].join(" ")).get() as {
      resource_id: string;
      origin: string;
      locator_json: string;
      metadata_status: string;
      availability: string;
    };
    expect(row).toMatchObject({
      origin: "agent_created",
      metadata_status: "fallback",
      availability: "available",
    });
    expect(JSON.parse(row.locator_json)).toEqual({ kind: "filesystem", path });
    expect(finalized.resourceEffects.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: row.resource_id,
        type: "created",
      }),
    ]));

    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });
    expect(validation.resourceManifest.resources).toEqual([
      expect.objectContaining({
        locator: { kind: "filesystem", path },
        availability: "available",
        role: "output",
        metadataStatus: "fallback",
      }),
    ]);
    expect(validation.currentRequest?.status).toBe("active");
    expect(validation.progress.entries).toEqual([
      expect.objectContaining({
        workCompleted: ["Created index.html."],
        verifiedMutations: [
          "Created `" + row.resource_id + "`: Created index.html.",
        ],
      }),
    ]);
    expect(await committedMutationCount(
      selected.workstream.contextRepositoryPath,
    )).toBe(1);
  });

  it("registers a verified directory without recursively fingerprinting its contents", async () => {
    const fixture = await createFixture("shallow-directory");
    await createBoundWorkstream(fixture, {
      title: "Shallow Directory Resource",
      objective: "Register a directory without scanning the entire project.",
    });
    const directory = join(fixture.root, "workspace", "large-project");
    await mkdir(join(directory, "nested"), { recursive: true });
    await writeFile(join(directory, "nested", "existing.txt"), "existing\n", "utf8");

    await fixture.service.finalizeRun(incompleteFinalization(fixture, [{
      effectId: "FRE-000000000000000000000007",
      operation: "created",
      path: directory,
      kind: "directory",
      step: 1,
      callId: "create-project-directory",
      tool: "create_directory",
      before: { exists: false },
      after: { exists: true, kind: "directory" },
    }]));

    const row = fixture.database.prepare([
      "SELECT current_version_json FROM resources",
      "WHERE locator_key = ?",
    ].join(" ")).get("filesystem:" + directory) as {
      current_version_json: string;
    };
    const version = JSON.parse(row.current_version_json) as {
      key: string;
      entryCount?: number;
    };
    expect(version.key).toMatch(/^directory-entry:[a-f0-9]{64}$/);
    expect(version.entryCount).toBeUndefined();
  });

  it("restores a known missing resource instead of creating a duplicate identity", async () => {
    const fixture = await createFixture("restore-missing");
    const path = join(fixture.root, "workspace", "restored.txt");
    const missing = await fixture.service.inspectResourceForRun({
      requestId: "REQ-resource-effects-restore-missing",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path },
      kind: "file",
      origin: "agent_discovered",
      description: "A durable output expected at this location.",
      aliases: ["restored output"],
      at: "2026-07-28T11:55:00.000Z",
    });
    const selected = await createBoundWorkstream(fixture, {
      title: "Restore Missing Resource",
      objective: "Reuse a known resource identity when its bytes appear.",
    });
    await mkdir(join(fixture.root, "workspace"), { recursive: true });
    await writeFile(path, "restored\n", "utf8");

    const finalized = await fixture.service.finalizeRun(incompleteFinalization(fixture, [
      unaryEffect("FRE-000000000000000000000008", "created", path, 1, "restore-file"),
    ]));

    const resources = fixture.database.prepare([
      "SELECT resource_id, availability FROM resources",
      "WHERE locator_key = ?",
    ].join(" ")).all("filesystem:" + path) as Array<{
      resource_id: string;
      availability: string;
    }>;
    expect(resources).toEqual([{
      resource_id: missing.resource.resourceId,
      availability: "available",
    }]);
    const events = fixture.database.prepare([
      "SELECT event_type FROM resource_events",
      "WHERE run_id = ? AND resource_id = ?",
    ].join(" ")).all(
      fixture.prepared.run.runId,
      missing.resource.resourceId,
    ) as Array<{ event_type: string }>;
    expect(events.map((event) => event.event_type)).toContain("restored");
    expect(finalized.resourceEffects.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: missing.resource.resourceId,
        type: "restored",
      }),
    ]));

    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });
    expect(validation.progress.entries).toEqual([
      expect.objectContaining({
        workCompleted: ["Restored restored.txt."],
        verifiedMutations: [
          "Restored `" + missing.resource.resourceId + "`: Restored restored.txt.",
        ],
      }),
    ]);
    expect(await committedMutationCount(
      selected.workstream.contextRepositoryPath,
    )).toBe(1);
  });

  it("keeps intermediate receipt hashes while reconciling the latest verified bytes", async () => {
    const fixture = await createFixture("sequential-hashes");
    await createBoundWorkstream(fixture, {
      title: "Sequential File Versions",
      objective: "Retain truthful versions for multiple writes in one run.",
    });
    const path = join(fixture.root, "workspace", "sequential.txt");
    const firstHash = sha256("first\n");
    const secondHash = sha256("second\n");
    await mkdir(join(fixture.root, "workspace"), { recursive: true });
    await writeFile(path, "second\n", "utf8");

    await fixture.service.finalizeRun(incompleteFinalization(fixture, [{
      ...unaryEffect(
        "FRE-000000000000000000000009",
        "created",
        path,
        1,
        "create-version",
      ),
      after: { exists: true, kind: "file", sha256: firstHash },
    }, {
      effectId: "FRE-00000000000000000000000A",
      operation: "modified",
      path,
      kind: "file",
      step: 2,
      callId: "modify-version",
      tool: "write_files",
      before: { exists: true, kind: "file", sha256: firstHash },
      after: { exists: true, kind: "file", sha256: secondHash },
    }]));

    const events = fixture.database.prepare([
      "SELECT call_id, after_version_json FROM resource_events",
      "WHERE run_id = ? AND call_id IN (?, ?) ORDER BY step",
    ].join(" ")).all(
      fixture.prepared.run.runId,
      "create-version",
      "modify-version",
    ) as Array<{ call_id: string; after_version_json: string }>;
    expect(events.map((event) => ({
      callId: event.call_id,
      sha256: (JSON.parse(event.after_version_json) as { sha256?: string }).sha256,
    }))).toEqual([
      { callId: "create-version", sha256: firstHash },
      { callId: "modify-version", sha256: secondHash },
    ]);
  });

  it("rejects a final file whose bytes no longer match the latest verified receipt", async () => {
    const fixture = await createFixture("changed-after-verification");
    await createBoundWorkstream(fixture, {
      title: "Changed After Verification",
      objective: "Reject stale mutation evidence before catalog updates.",
    });
    const path = join(fixture.root, "workspace", "changed.txt");
    await mkdir(join(fixture.root, "workspace"), { recursive: true });
    await writeFile(path, "externally changed\n", "utf8");

    await expect(fixture.service.finalizeRun(incompleteFinalization(fixture, [{
      ...unaryEffect(
        "FRE-00000000000000000000000B",
        "created",
        path,
        1,
        "stale-create",
      ),
      after: {
        exists: true,
        kind: "file",
        sha256: sha256("verified bytes\n"),
      },
    }]))).rejects.toMatchObject({ code: "RESOURCE_VERIFICATION_UNAVAILABLE" });

    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM resources").get())
      .toEqual({ count: 0 });
  });

  it("keeps move identity, gives a copy its own identity, and retains deletion history", async () => {
    const fixture = await createFixture("move-copy-delete");
    const selected = await createBoundWorkstream(fixture, {
      title: "Resource Lifecycle",
      objective: "Track one file through move, copy, and delete operations.",
    });
    const directory = join(fixture.root, "workspace", "lifecycle");
    const source = join(directory, "draft.txt");
    const destination = join(directory, "final.txt");
    const copy = join(directory, "temporary-copy.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(source, "durable lifecycle\n", "utf8");
    await rename(source, destination);
    await copyFile(destination, copy);
    await unlink(copy);

    const effects: VerifiedFilesystemResourceEffect[] = [{
      effectId: "FRE-000000000000000000000002",
      operation: "moved",
      sourcePath: source,
      destinationPath: destination,
      kind: "file",
      step: 1,
      callId: "move-file",
      tool: "move",
      before: { exists: true, kind: "file" },
      after: { exists: true, kind: "file" },
    }, {
      effectId: "FRE-000000000000000000000003",
      operation: "copied",
      sourcePath: destination,
      destinationPath: copy,
      kind: "file",
      step: 2,
      callId: "copy-file",
      tool: "copy",
      before: { exists: true, kind: "file" },
      after: { exists: true, kind: "file" },
    }, unaryEffect(
      "FRE-000000000000000000000004",
      "deleted",
      copy,
      3,
      "delete-copy",
    )];

    await fixture.service.finalizeRun(incompleteFinalization(fixture, effects));

    const resources = fixture.database.prepare([
      "SELECT resource_id, locator_json, availability, metadata_json",
      "FROM resources ORDER BY resource_id",
    ].join(" ")).all() as Array<{
      resource_id: string;
      locator_json: string;
      availability: string;
      metadata_json: string;
    }>;
    expect(resources).toHaveLength(2);
    const moved = resources.find((row) =>
      (JSON.parse(row.locator_json) as { path: string }).path === destination);
    const deletedCopy = resources.find((row) =>
      (JSON.parse(row.locator_json) as { path: string }).path === copy);
    expect(moved).toBeDefined();
    expect(deletedCopy).toBeDefined();
    expect(moved?.resource_id).not.toBe(deletedCopy?.resource_id);
    expect(moved?.availability).toBe("available");
    expect(deletedCopy?.availability).toBe("deleted");
    expect(JSON.parse(moved!.metadata_json)).toMatchObject({
      formerLocators: [{ kind: "filesystem", path: source }],
    });

    const eventTypes = fixture.database.prepare([
      "SELECT event_type FROM resource_events",
      "WHERE run_id = ? ORDER BY created_at, event_id",
    ].join(" ")).all(fixture.prepared.run.runId) as Array<{ event_type: string }>;
    expect(eventTypes.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      "moved",
      "created",
      "deleted",
    ]));

    const validation = await validateWorkstreamRepository({
      workstreamRoot: join(fixture.root, "workstreams"),
      contextRepositoryPath: selected.workstream.contextRepositoryPath,
      expectedWorkstreamId: selected.workstream.workstreamId,
    });
    expect(validation.resourceManifest.resources).toHaveLength(2);
    expect(validation.resourceManifest.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resourceId: moved?.resource_id,
        locator: { kind: "filesystem", path: destination },
        formerLocators: [{ kind: "filesystem", path: source }],
        availability: "available",
        metadataStatus: "fallback",
      }),
      expect.objectContaining({
        resourceId: deletedCopy?.resource_id,
        locator: { kind: "filesystem", path: copy },
        availability: "deleted",
        metadataStatus: "fallback",
      }),
    ]));

    const search = await fixture.service.findResources({
      query: "draft",
      includeMissing: true,
    });
    expect(search.resources).toEqual([
      expect.objectContaining({
        resource: expect.objectContaining({
          resourceId: moved?.resource_id,
          locator: { kind: "filesystem", path: destination },
        }),
      }),
    ]);
  });

  it("allows a new resource to be created later at a moved resource's former path", async () => {
    const fixture = await createFixture("former-path-reuse");
    await createBoundWorkstream(fixture, {
      title: "Former Path Reuse",
      objective: "Keep stable identities when a former path is reused.",
    });
    const directory = join(fixture.root, "workspace", "reuse");
    const source = join(directory, "notes.txt");
    const destination = join(directory, "archived-notes.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(source, "original\n", "utf8");
    await rename(source, destination);
    await writeFile(source, "replacement\n", "utf8");

    await fixture.service.finalizeRun(incompleteFinalization(fixture, [{
      effectId: "FRE-000000000000000000000005",
      operation: "moved",
      sourcePath: source,
      destinationPath: destination,
      kind: "file",
      step: 1,
      callId: "move-notes",
      tool: "move",
      before: { exists: true, kind: "file" },
      after: { exists: true, kind: "file" },
    }, unaryEffect(
      "FRE-000000000000000000000006",
      "created",
      source,
      2,
      "write-replacement",
    )]));

    const rows = fixture.database.prepare([
      "SELECT resource_id, locator_json FROM resources ORDER BY resource_id",
    ].join(" ")).all() as Array<{
      resource_id: string;
      locator_json: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.resource_id)).size).toBe(2);
    expect(rows.map((row) =>
      (JSON.parse(row.locator_json) as { path: string }).path).sort()).toEqual([
      destination,
      source,
    ].sort());
  });
});

async function createFixture(name: string): Promise<WorkstreamServiceFixture> {
  const fixture = await createWorkstreamServiceFixture(
    "resource-effects-" + name,
    "Exercise durable resource lifecycle effects.",
  );
  fixtures.push(fixture);
  return fixture;
}

function incompleteFinalization(
  fixture: WorkstreamServiceFixture,
  effects: VerifiedFilesystemResourceEffect[],
): FinalizeRunRequest {
  return {
    requestId: fixture.prepared.run.runId + ":finalize",
    runId: fixture.prepared.run.runId,
    outcome: "incomplete",
    stopReason: "run_limit",
    assistantResponse: "Verified progress was preserved for the next run.",
    streamSummary: "The request remains active with verified filesystem progress.",
    summary: "Verified filesystem progress is durable.",
    validation: "not_applicable",
    next: "Continue the active request.",
    workState: workState({
      status: "in_progress",
      summary: "Verified filesystem progress is durable.",
      nextAction: "Continue the active request.",
    }),
    workstream: {
      completion: {
        accepted: false,
        effects,
        resources: [],
        missing: [],
        failures: [],
        criteria: [],
      },
      requestEffect: { kind: "none" },
    },
    at: "2026-07-28T12:00:00.000Z",
  };
}

function unaryEffect(
  effectId: string,
  operation: "created" | "deleted",
  path: string,
  step: number,
  callId: string,
): VerifiedFilesystemResourceEffect {
  return {
    effectId,
    operation,
    path,
    kind: "file",
    step,
    callId,
    tool: operation === "created" ? "write_files" : "delete",
    before: operation === "created"
      ? { exists: false }
      : { exists: true, kind: "file" },
    after: operation === "deleted"
      ? { exists: false }
      : { exists: true, kind: "file" },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function committedMutationCount(repositoryPath: string): Promise<number> {
  const result = await execFileAsync(
    "git",
    ["show", "-s", "--format=%B", "HEAD"],
    { cwd: repositoryPath, encoding: "utf8" },
  );
  const metadata = parseWorkstreamCommit(result.stdout);
  if (metadata?.event !== "workstream_bound_run_finalized") {
    throw new Error("Expected a finalized workstream run commit.");
  }
  return metadata.mutations;
}
