import { execFile } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkstreamServiceFixture,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const execFileAsync = promisify(execFile);
const fixtures: WorkstreamServiceFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
});

describe("resource locator inspection", () => {
  it("registers a canonical file identity with searchable agent metadata", async () => {
    const fixture = await createWorkstreamServiceFixture("inspect-file", "Read a local design note.");
    fixtures.push(fixture);
    const path = join(fixture.root, "user-files", "design.md");
    await mkdir(join(fixture.root, "user-files"));
    await writeFile(path, "# Design\n", "utf8");

    const inspected = await fixture.service.inspectResourceForRun({
      requestId: "REQ-inspect-file",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path },
      origin: "user_reference",
      displayName: "System design",
      description: "Architecture note supplied by the user.",
      aliases: ["design note", "architecture reference"],
      at: "2026-07-19T10:01:00+05:30",
    });

    expect(inspected).toMatchObject({
      existing: false,
      mutationEligible: true,
      warnings: [],
      resource: {
        kind: "document",
        displayName: "System design",
        description: "Architecture note supplied by the user.",
        aliases: expect.arrayContaining(["design note", "architecture reference"]),
        locator: { kind: "filesystem", path },
        version: { exists: true, kind: "file", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        availability: "available",
        metadataStatus: "enriched",
      },
    });
    expect((await fixture.service.findResources({ query: "architecture reference" })).resources[0])
      .toMatchObject({ resource: { resourceId: inspected.resource.resourceId } });
  });

  it("tracks missing filesystem identities without returning them in normal search", async () => {
    const fixture = await createWorkstreamServiceFixture("inspect-missing", "Remember a future output path.");
    fixtures.push(fixture);
    const path = join(fixture.root, "future", "report.pdf");

    const inspected = await fixture.service.inspectResourceForRun({
      requestId: "REQ-inspect-missing",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path },
      kind: "document",
      origin: "agent_discovered",
      description: "Report path requested by the user.",
      aliases: ["future report"],
      at: "2026-07-19T10:01:00+05:30",
    });

    expect(inspected).toMatchObject({
      mutationEligible: true,
      warnings: ["Filesystem resource does not currently exist."],
      resource: { availability: "missing", version: { exists: false, kind: "unversioned" } },
    });
    expect((await fixture.service.findResources({ query: "future report" })).resources).toEqual([]);
    expect((await fixture.service.findResources({
      resourceIds: [inspected.resource.resourceId],
      includeMissing: true,
    })).resources).toHaveLength(1);
  });

  it("rejects symbolic-link locators before catalog mutation", async () => {
    const fixture = await createWorkstreamServiceFixture("inspect-symlink", "Inspect a local path.");
    fixtures.push(fixture);
    const target = join(fixture.root, "target.txt");
    const link = join(fixture.root, "link.txt");
    await writeFile(target, "safe bytes\n", "utf8");
    await symlink(target, link);

    await expect(fixture.service.inspectResourceForRun({
      requestId: "REQ-inspect-symlink",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path: link },
      origin: "agent_discovered",
      at: "2026-07-19T10:01:00+05:30",
    })).rejects.toMatchObject({ code: "RESOURCE_LOCATOR_INVALID" });
    expect(fixture.database.prepare("SELECT COUNT(*) AS count FROM resources").get())
      .toEqual({ count: 0 });
  });

  it("observes an existing Git repository without initializing, committing, or adding Ayati files", async () => {
    const fixture = await createWorkstreamServiceFixture("inspect-git", "Continue an existing project.");
    fixtures.push(fixture);
    const path = join(fixture.root, "existing-project");
    await mkdir(path);
    await git(path, ["init", "--initial-branch=trunk"]);
    await git(path, ["config", "user.name", "Existing User"]);
    await git(path, ["config", "user.email", "existing@example.invalid"]);
    await writeFile(join(path, "README.md"), "# Existing\n", "utf8");
    await git(path, ["add", "--", "README.md"]);
    await git(path, ["commit", "-m", "initial project"]);
    const head = await git(path, ["rev-parse", "HEAD"]);
    await writeFile(join(path, "README.md"), "# Existing\n\nUncommitted note.\n", "utf8");

    const inspected = await fixture.service.inspectResourceForRun({
      requestId: "REQ-inspect-git",
      runId: fixture.prepared.run.runId,
      locator: { kind: "filesystem", path },
      kind: "git_repository",
      origin: "user_reference",
      at: "2026-07-19T10:01:00+05:30",
    });

    expect(inspected).toMatchObject({
      mutationEligible: true,
      warnings: ["Git resource currently has uncommitted changes."],
      resource: {
        kind: "git_repository",
        version: { kind: "git", head, dirty: true },
      },
    });
    expect(await git(path, ["rev-list", "--count", "HEAD"])).toBe("1");
    expect(await git(path, ["status", "--porcelain", "--untracked-files=all"]))
      .toContain("README.md");
    expect(await git(path, ["ls-files"])).toBe("README.md");
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd });
  return result.stdout.trim();
}
