import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const execFileAsync = promisify(execFile);
const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("workstream context repository creation", () => {
  it("creates one context-only Git repository and a separate default output resource", async () => {
    const fixture = await createWorkstreamServiceFixture("create-layout");
    fixtures.push(fixture);

    const selected = await createBoundWorkstream(fixture, {
      title: "Coffee Shop Website",
      objective: "Build a small coffee-shop website.",
    });

    expect(selected.run.runId).toBe(fixture.prepared.run.runId);
    expect(selected.run.workstreamBinding).toEqual({
      workstreamId: selected.workstream.workstreamId,
      requestId: "R-0001",
      boundAt: "2026-07-19T10:01:00+05:30",
    });
    expect(dirname(selected.workstream.contextRepositoryPath)).toBe(join(fixture.root, "workstreams"));
    expect(await git(selected.workstream.contextRepositoryPath, ["status", "--porcelain"])).toBe("");
    expect((await git(selected.workstream.contextRepositoryPath, [
      "ls-tree", "-r", "--name-only", "HEAD",
    ])).split("\n")).toEqual([
      "requests/R-0001-coffee-shop-website.md",
      "resources.json",
      "workstream.md",
    ]);
    const primary = selected.resourceBindings.find((binding) => binding.primary);
    expect(primary).toMatchObject({ role: "primary", access: "mutate" });
    expect(primary?.resource.locator).toMatchObject({ kind: "filesystem" });
    if (primary?.resource.locator.kind !== "filesystem") throw new Error("Expected filesystem output.");
    expect(dirname(primary.resource.locator.path)).toBe(join(fixture.root, "workspace"));
    expect(primary.resource.locator.path).not.toBe(selected.workstream.contextRepositoryPath);
    await expect(access(primary.resource.locator.path)).resolves.toBeUndefined();
  });

  it("replays creation without allocating another run, workstream, or output", async () => {
    const fixture = await createWorkstreamServiceFixture("create-replay");
    fixtures.push(fixture);
    const input = {
      requestId: "REQ-create-replay",
      title: "Research Renewable Storage",
      objective: "Collect and synthesize evidence about energy storage.",
    };

    const first = await createBoundWorkstream(fixture, input);
    const replayed = await createBoundWorkstream(fixture, input);

    expect(replayed).toEqual(first);
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM workstreams").get())
      .toEqual({ count: 1 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM workstream_resources").get())
      .toEqual({ count: 1 });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM runs").get())
      .toEqual({ count: 1 });
  });

  it("rejects invalid resource bindings before allocating a workstream", async () => {
    const fixture = await createWorkstreamServiceFixture("create-invalid-resource");
    fixtures.push(fixture);

    await expect(createBoundWorkstream(fixture, {
      resources: [{
        resourceId: "RES-FFFFFFFFFFFFFFFFFFFFFFFF",
        role: "primary",
        access: "mutate",
        primary: true,
      }],
    })).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM workstreams").get())
      .toEqual({ count: 0 });
    expect(fixture.database.prepare(
      "SELECT workstream_id FROM runs WHERE run_id = ?",
    ).get(fixture.prepared.run.runId)).toEqual({ workstream_id: null });
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}
