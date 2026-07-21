import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  PrepareResourceMutationRequest,
  ResourceAdmission,
} from "../src/contracts.js";
import {
  createBoundWorkstream,
  createWorkstreamServiceFixture,
  type WorkstreamServiceFixture,
} from "./simple-workstream-repository-fixtures.js";

interface MutationFixture {
  fixture: WorkstreamServiceFixture;
  resourceRoot: string;
  resourceId: string;
  activeRequestId: string;
  versionKey: string;
}

const fixtures: WorkstreamServiceFixture[] = [];
const resourceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.dispose()));
  await Promise.all(resourceRoots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

describe("resource-scoped mutation authority", () => {
  it("rejects mutation until the run owns a workstream and request", async () => {
    const resourceRoot = await createResourceRoot("unbound");
    const fixture = await createWorkstreamServiceFixture(
      "mutation-unbound",
      "Update the example source.",
      [directoryAdmission(resourceRoot)],
    );
    fixtures.push(fixture);
    const resource = fixture.prepared.context.ingressResources?.[0];
    if (!resource) throw new Error("Expected admitted resource.");

    await expect(fixture.service.prepareResourceMutation({
      requestId: "REQ-unbound-mutation",
      runId: fixture.prepared.run.runId,
      workstreamId: "W-20260719-9999",
      activeRequestId: "R-0001",
      callId: "call-write",
      tool: "write_files",
      effect: "workspace_mutation",
      targets: [{ resourceId: resource.resourceId, relativePath: "src/app.ts", kind: "file" }],
      at: "2026-07-19T10:01:00+05:30",
    })).rejects.toMatchObject({ code: "MUTATION_REQUIRES_WORKSTREAM_BINDING" });
  });

  it("authorizes exact targets and replays the same active capability", async () => {
    const state = await createMutationFixture("replay");
    const input = mutationInput(state, "call-replay", "src/app.ts");

    const prepared = await state.fixture.service.prepareResourceMutation(input);
    const replayed = await state.fixture.service.prepareResourceMutation(input);

    expect(replayed).toEqual(prepared);
    expect(prepared).toMatchObject({
      leaseId: expect.stringMatching(/^RL-/),
      operationId: expect.stringMatching(/^RM-/),
      targets: [{
        resourceId: state.resourceId,
        relativePath: "src/app.ts",
        kind: "file",
        expectedVersionKey: state.versionKey,
        resolvedPath: join(state.resourceRoot, "src", "app.ts"),
      }],
    });
    expect(prepared.lockToken.length).toBeGreaterThan(20);
    expect(state.fixture.database.prepare([
      "SELECT status, workstream_id, bound_request_id FROM resource_mutation_leases",
      "WHERE lease_id = ?",
    ].join(" ")).get(prepared.leaseId)).toEqual({
      status: "active",
      workstream_id: expect.stringMatching(/^W-/),
      bound_request_id: state.activeRequestId,
    });
  });

  it("rejects stale versions and resources without mutate access", async () => {
    const state = await createMutationFixture("guards");
    await expect(state.fixture.service.prepareResourceMutation({
      ...mutationInput(state, "call-stale", "src/app.ts"),
      targets: [{
        resourceId: state.resourceId,
        relativePath: "src/app.ts",
        kind: "file",
        expectedVersionKey: "directory:stale",
      }],
    })).rejects.toMatchObject({ code: "RESOURCE_VERSION_MISMATCH" });

    const readOnlyRoot = await createResourceRoot("read-only");
    const inspected = await state.fixture.service.inspectResourceForRun({
      requestId: "REQ-inspect-read-only",
      runId: state.fixture.prepared.run.runId,
      locator: { kind: "filesystem", path: readOnlyRoot },
      kind: "directory",
      origin: "agent_discovered",
      at: "2026-07-19T10:02:00+05:30",
    });
    await state.fixture.service.bindResourcesForRun({
      requestId: "REQ-bind-read-only",
      runId: state.fixture.prepared.run.runId,
      workstreamId: boundWorkstreamId(state),
      bindings: [{ resourceId: inspected.resource.resourceId, role: "reference", access: "read" }],
      at: "2026-07-19T10:03:00+05:30",
    });
    await expect(state.fixture.service.prepareResourceMutation({
      ...mutationInput(state, "call-read-only", "src/app.ts"),
      targets: [{
        resourceId: inspected.resource.resourceId,
        relativePath: "src/app.ts",
        kind: "file",
      }],
    })).rejects.toMatchObject({ code: "RESOURCE_MUTATION_UNAVAILABLE" });
  });

  it("verifies a declared filesystem change, records one event, and releases the lease", async () => {
    const state = await createMutationFixture("verified");
    const prepared = await state.fixture.service.prepareResourceMutation(
      mutationInput(state, "call-verified", "src/app.ts"),
    );
    await writeFile(join(state.resourceRoot, "src", "app.ts"), "export const ready = true;\n");

    const input = {
      requestId: "REQ-verify-success",
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      lockToken: prepared.lockToken,
      toolStatus: "completed" as const,
      at: "2026-07-19T10:03:00+05:30",
    };
    const verified = await state.fixture.service.verifyResourceMutation(input);
    const replayed = await state.fixture.service.verifyResourceMutation(input);

    expect(replayed).toEqual(verified);
    expect(verified).toMatchObject({
      status: "verified",
      verified: true,
      events: [{
        resourceId: state.resourceId,
        workstreamId: boundWorkstreamId(state),
        requestId: state.activeRequestId,
        runId: state.fixture.prepared.run.runId,
        callId: "call-verified",
        type: "modified",
        afterVersion: { exists: true, kind: "directory" },
      }],
    });
    expect(state.fixture.database.prepare(
      "SELECT status FROM resource_mutation_leases WHERE lease_id = ?",
    ).get(prepared.leaseId)).toEqual({ status: "released" });
  });

  it("marks unexpected or failed partial changes recovery-required without deleting them", async () => {
    const unexpected = await createMutationFixture("unexpected");
    const first = await unexpected.fixture.service.prepareResourceMutation(
      mutationInput(unexpected, "call-unexpected", "src/app.ts"),
    );
    await writeFile(join(unexpected.resourceRoot, "other.txt"), "must be preserved\n");
    await expect(unexpected.fixture.service.verifyResourceMutation({
      requestId: "REQ-verify-unexpected",
      operationId: first.operationId,
      leaseId: first.leaseId,
      lockToken: first.lockToken,
      toolStatus: "completed",
      at: "2026-07-19T10:03:00+05:30",
    })).resolves.toMatchObject({ status: "recovery_required", verified: false, events: [] });
    expect(stateOfRun(unexpected)).toBe("recovery_required");

    const failed = await createMutationFixture("failed-partial");
    const second = await failed.fixture.service.prepareResourceMutation(
      mutationInput(failed, "call-failed", "src/app.ts"),
    );
    await writeFile(join(failed.resourceRoot, "src", "app.ts"), "partial\n");
    await expect(failed.fixture.service.verifyResourceMutation({
      requestId: "REQ-verify-failed",
      operationId: second.operationId,
      leaseId: second.leaseId,
      lockToken: second.lockToken,
      toolStatus: "failed",
      at: "2026-07-19T10:03:00+05:30",
    })).resolves.toMatchObject({ status: "recovery_required", verified: false, events: [] });
    expect(stateOfRun(failed)).toBe("recovery_required");
  });

  it("releases a no-change operation and rejects an invalid capability token", async () => {
    const state = await createMutationFixture("no-change");
    const prepared = await state.fixture.service.prepareResourceMutation(
      mutationInput(state, "call-no-change", "src/app.ts"),
    );
    await expect(state.fixture.service.verifyResourceMutation({
      requestId: "REQ-invalid-token",
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      lockToken: "not-the-capability",
      toolStatus: "completed",
      at: "2026-07-19T10:02:00+05:30",
    })).rejects.toMatchObject({ code: "MUTATION_LOCK_INVALID" });

    await expect(state.fixture.service.verifyResourceMutation({
      requestId: "REQ-no-change",
      operationId: prepared.operationId,
      leaseId: prepared.leaseId,
      lockToken: prepared.lockToken,
      toolStatus: "failed",
      at: "2026-07-19T10:03:00+05:30",
    })).resolves.toMatchObject({ status: "no_change", verified: true, events: [] });
  });
});

async function createMutationFixture(name: string): Promise<MutationFixture> {
  const resourceRoot = await createResourceRoot(name);
  await writeFile(join(resourceRoot, "src", "app.ts"), "export const ready = false;\n");
  const fixture = await createWorkstreamServiceFixture(
    "mutation-" + name,
    "Update the example source.",
    [directoryAdmission(resourceRoot)],
  );
  fixtures.push(fixture);
  const resource = fixture.prepared.context.ingressResources?.[0];
  if (!resource) throw new Error("Expected admitted resource.");
  const selected = await createBoundWorkstream(fixture, {
    title: "Resource Mutation",
    objective: "Update a real resource through an exact verified scope.",
    resources: [{ resourceId: resource.resourceId, role: "primary", access: "mutate", primary: true }],
  });
  const binding = selected.run.workstreamBinding;
  if (!binding) throw new Error("Expected workstream binding.");
  return {
    fixture,
    resourceRoot,
    resourceId: resource.resourceId,
    activeRequestId: binding.requestId,
    versionKey: selected.resourceBindings[0]?.resource.version.key ?? resource.version.key,
  };
}

async function createResourceRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ayati-mutation-resource-${name}-`));
  resourceRoots.push(root);
  await mkdir(join(root, "src"), { recursive: true });
  return root;
}

function directoryAdmission(path: string): ResourceAdmission {
  return {
    admissionId: "resource:" + path,
    kind: "directory",
    origin: "user_reference",
    locator: { kind: "filesystem", path },
    displayName: "Mutation resource",
    description: "Real filesystem output owned by the user.",
    aliases: ["example source"],
    role: "reference",
  };
}

function mutationInput(
  state: MutationFixture,
  callId: string,
  relativePath: string,
): PrepareResourceMutationRequest {
  return {
    requestId: `REQ-${callId}-prepare`,
    runId: state.fixture.prepared.run.runId,
    workstreamId: boundWorkstreamId(state),
    activeRequestId: state.activeRequestId,
    callId,
    tool: "write_files",
    effect: "workspace_mutation",
    targets: [{
      resourceId: state.resourceId,
      relativePath,
      kind: "file",
      expectedVersionKey: state.versionKey,
    }],
    at: "2026-07-19T10:02:00+05:30",
  };
}

function boundWorkstreamId(state: MutationFixture): string {
  const binding = state.fixture.prepared.run.workstreamBinding;
  if (binding) return binding.workstreamId;
  const row = state.fixture.database.prepare(
    "SELECT workstream_id FROM runs WHERE run_id = ?",
  ).get(state.fixture.prepared.run.runId) as { workstream_id: string };
  return row.workstream_id;
}

function stateOfRun(state: MutationFixture): string {
  const row = state.fixture.database.prepare(
    "SELECT status FROM runs WHERE run_id = ?",
  ).get(state.fixture.prepared.run.runId) as { status: string };
  return row.status;
}
