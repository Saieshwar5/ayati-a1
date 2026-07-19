import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResourceAdmission } from "../src/contracts.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  workState,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

const fixtures: WorkstreamServiceFixture[] = [];
const externalRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
  await Promise.all(externalRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("resource catalog and durable workstream relationships", () => {
  it("copies user attachment bytes into an immutable content-addressed store", async () => {
    const sourceRoot = await externalRoot("attachment");
    const source = join(sourceRoot, "notes.txt");
    const bytes = "durable attachment bytes\n";
    await writeFile(source, bytes, "utf8");
    const admission: ResourceAdmission = {
      admissionId: "upload-notes",
      kind: "document",
      origin: "user_attachment",
      locator: { kind: "filesystem", path: source },
      displayName: "notes.txt",
      description: "Notes supplied by the user.",
      aliases: ["study notes"],
      role: "attachment",
    };
    const fixture = await createWorkstreamServiceFixture(
      "attachment-store",
      "Summarize the attached notes.",
      [admission],
    );
    fixtures.push(fixture);

    const resource = fixture.prepared.context.ingressResources?.[0];
    expect(resource).toMatchObject({
      kind: "document",
      origin: "user_attachment",
      locator: { kind: "managed_blob" },
      description: "Notes supplied by the user.",
      aliases: ["study notes"],
      availability: "available",
    });
    const digest = createHash("sha256").update(bytes).digest("hex");
    expect(resource?.resourceId).toBe("RES-" + digest.slice(0, 24).toUpperCase());
    const storedPath = join(fixture.root, ".ayati", "resources", "sha256", digest.slice(0, 2), digest);
    expect(await readFile(storedPath, "utf8")).toBe(bytes);

    await writeFile(source, "changed source bytes\n", "utf8");
    const replayed = await fixture.service.prepareContextTurn({
      requestId: "REQ-attachment-store-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Summarize the attached notes.",
      resources: [admission],
      at: "2026-07-19T10:00:00+05:30",
    });
    expect(replayed.run.runId).toBe(fixture.prepared.run.runId);
    expect(await readFile(storedPath, "utf8")).toBe(bytes);
  });

  it("finds a workstream by a bound resource path, alias, and resource identity", async () => {
    const project = await externalRoot("owned-resource");
    await mkdir(join(project, "src"));
    await writeFile(join(project, "src", "index.ts"), "export {};\n", "utf8");
    const fixture = await createWorkstreamServiceFixture(
      "resource-search",
      "Continue work in the referenced TypeScript project.",
      [directoryAdmission(project, "TypeScript playground", ["ts playground", "learning code"])],
    );
    fixtures.push(fixture);
    const resource = fixture.prepared.context.ingressResources?.[0];
    if (!resource) throw new Error("Expected admitted resource.");
    const selected = await createBoundWorkstream(fixture, {
      title: "Learn TypeScript",
      objective: "Build TypeScript skill through durable exercises.",
      resources: [{
        resourceId: resource.resourceId,
        role: "primary",
        access: "mutate",
        primary: true,
      }],
    });

    expect((await fixture.service.findResources({ query: "learning code" })).resources[0])
      .toMatchObject({
        resource: { resourceId: resource.resourceId },
        workstreamIds: [selected.workstream.workstreamId],
      });
    expect((await fixture.service.findWorkstreams({
      paths: [join(project, "src", "index.ts")],
      limit: 10,
    })).workstreams[0]).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      primaryResources: [{ resourceId: resource.resourceId }],
      discovery: { tier: "definite", reasons: expect.arrayContaining(["owned_resource"]) },
    });
    expect((await fixture.service.findWorkstreams({
      query: resource.resourceId,
      limit: 10,
    })).workstreams[0]).toMatchObject({
      workstreamId: selected.workstream.workstreamId,
      discovery: { tier: "definite", reasons: expect.arrayContaining(["exact_resource_id"]) },
    });
  });

  it("inspects and searches a URL resource with deterministic fallback metadata", async () => {
    const fixture = await createWorkstreamServiceFixture("inspect-url", "Read a reference URL.");
    fixtures.push(fixture);
    const input = {
      requestId: "REQ-inspect-url",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      locator: { kind: "url" as const, url: "https://example.com/guide#section" },
      kind: "url" as const,
      origin: "agent_discovered" as const,
      description: "Reference guide for the current question.",
      aliases: ["example guide"],
      at: "2026-07-19T10:01:00+05:30",
    };

    const first = await fixture.service.inspectResourceForRun(input);
    const replayed = await fixture.service.inspectResourceForRun(input);

    expect(replayed).toEqual(first);
    expect(first).toMatchObject({
      existing: false,
      mutationEligible: false,
      resource: {
        locator: { kind: "url", url: "https://example.com/guide" },
        metadataStatus: "enriched",
      },
    });
    expect((await fixture.service.getActiveContext({
      sessionId: fixture.prepared.session.sessionId,
    })).ingressResources).toContainEqual(expect.objectContaining({
      resourceId: first.resource.resourceId,
    }));
    expect((await fixture.service.findResources({ query: "example guide" })).resources)
      .toContainEqual(expect.objectContaining({ resource: expect.objectContaining({
        resourceId: first.resource.resourceId,
      }) }));
  });

  it("allows one resource identity to relate to multiple durable workstreams", async () => {
    const project = await externalRoot("shared-resource");
    const fixture = await createWorkstreamServiceFixture(
      "shared-resource",
      "Start the first stream of work.",
      [directoryAdmission(project, "shared workspace", ["shared output"])],
    );
    fixtures.push(fixture);
    const resource = fixture.prepared.context.ingressResources?.[0];
    if (!resource) throw new Error("Expected admitted resource.");
    const first = await createBoundWorkstream(fixture, {
      title: "Research Track",
      resources: [{ resourceId: resource.resourceId, role: "primary", access: "mutate", primary: true }],
    });
    await fixture.service.finalizeRun({
      requestId: "REQ-shared-first-finalize",
      sessionId: fixture.prepared.session.sessionId,
      runId: fixture.prepared.run.runId,
      outcome: "incomplete",
      stopReason: "run_limit",
      assistantResponse: "The research track remains in progress.",
      conversationSummary: "Started the research track.",
      summary: "Research remains in progress.",
      validation: "not_applicable",
      next: "Continue collecting evidence.",
      workState: workState({ summary: "Research remains in progress." }),
      workstream: {
        completion: { accepted: false, resources: [], missing: [], failures: [], criteria: [] },
      },
      at: "2026-07-19T10:02:00+05:30",
    });
    const next = await fixture.service.prepareContextTurn({
      requestId: "REQ-shared-second-prepare",
      date: "2026-07-19",
      timezone: "Asia/Kolkata",
      agentId: "local",
      role: "user",
      content: "Start a separate learning stream using the same directory.",
      at: "2026-07-19T10:03:00+05:30",
    });
    fixture.prepared = next;
    const second = await createBoundWorkstream(fixture, {
      requestId: "REQ-shared-second-create",
      title: "Learning Track",
      objective: "Use the shared material for a separate learning outcome.",
      resources: [{ resourceId: resource.resourceId, role: "primary", access: "mutate", primary: true }],
    });

    expect((await fixture.service.findResources({ resourceIds: [resource.resourceId] })).resources[0]
      ?.workstreamIds.sort()).toEqual([
      first.workstream.workstreamId,
      second.workstream.workstreamId,
    ].sort());
  });
});

async function externalRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ayati-resource-${name}-`));
  externalRoots.push(root);
  return root;
}

function directoryAdmission(
  path: string,
  displayName: string,
  aliases: string[],
): ResourceAdmission {
  return {
    admissionId: "directory:" + displayName,
    kind: "directory",
    origin: "user_reference",
    locator: { kind: "filesystem", path },
    displayName,
    description: `Filesystem resource for ${displayName}.`,
    aliases,
    role: "reference",
  };
}
