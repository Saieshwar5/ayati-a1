import { describe, expect, it } from "vitest";
import {
  parseWorkstreamCard,
  renderWorkstreamCard,
  type WorkstreamCard,
} from "../src/workstreams/workstream-card.js";
import {
  parseWorkstreamCommit,
  renderWorkstreamCommit,
} from "../src/workstreams/workstream-commit-metadata.js";
import {
  parseWorkstreamResourceManifest,
  renderWorkstreamResourceManifest,
} from "../src/workstreams/workstream-resource-manifest.js";
import {
  parseWorkstreamRequest,
  renderWorkstreamRequest,
} from "../src/workstreams/workstream-request.js";

describe("workstream context contracts", () => {
  it("round-trips a context-only workstream card with no deliverable paths", () => {
    const card: WorkstreamCard = {
      schema: "ayati.workstream/v3",
      id: "W-20260719-0001",
      title: "Learning Rust",
      status: "active",
      currentRequest: "R-0001",
      aliases: ["rust learning"],
      purpose: "Build durable Rust knowledge over multiple days.",
      currentSnapshot: "Ownership and borrowing are understood at an introductory level.",
      importantFindings: ["Borrowing rules are the current learning boundary."],
      decisions: ["Keep external files in the resource catalog."],
      currentFocus: "Practice borrowing with three small examples.",
      openQuestions: [],
      blockers: [],
      nextAction: "Compile and explain three borrowing examples.",
    };
    const rendered = renderWorkstreamCard(card);
    expect(rendered).not.toContain("Important paths");
    expect(parseWorkstreamCard(rendered, card.id)).toEqual(card);
  });

  it("round-trips request context independently of deliverables", () => {
    const request = {
      schema: "ayati.request/v3" as const,
      id: "R-0001",
      workstreamId: "W-20260719-0001",
      relativePath: "requests/R-0001-practice-borrowing.md",
      title: "Practice borrowing",
      status: "active" as const,
      createdAt: "2026-07-19T10:00:00+05:30",
      updatedAt: "2026-07-19T10:00:00+05:30",
      startedAt: "2026-07-19T10:00:00+05:30",
      closedAt: null,
      source: "user" as const,
      request: "Create and explain three borrowing examples.",
      acceptance: ["All examples compile and are explained."],
      constraints: ["Keep each example small."],
      lifecycleNote: "Created as the active request.",
      finalOutcome: "Pending.",
    };
    expect(parseWorkstreamRequest(renderWorkstreamRequest(request), request.id)).toEqual(request);
  });

  it("round-trips the resource ledger with stable identities and real locators", () => {
    const manifest = {
      schema: "ayati.workstream-resources/v1" as const,
      workstreamId: "W-20260719-0001",
      updatedAt: "2026-07-19T10:05:00+05:30",
      resources: [{
        resourceId: "RES-1234567890ABCDEF12345678",
        kind: "directory" as const,
        origin: "agent_created" as const,
        role: "primary" as const,
        access: "mutate" as const,
        primary: true,
        requestIds: ["R-0001"],
        displayName: "rust-examples",
        description: "User-visible Rust practice output.",
        aliases: ["examples", "rust practice"],
        locator: { kind: "filesystem" as const, path: "/tmp/rust-examples" },
        version: {
          key: "directory:abc",
          observedAt: "2026-07-19T10:05:00+05:30",
          exists: true,
          kind: "directory" as const,
          fingerprint: "abc",
          entryCount: 1,
          sizeBytes: 0,
        },
        availability: "available" as const,
        lastUsedAt: "2026-07-19T10:05:00+05:30",
      }],
    };
    expect(parseWorkstreamResourceManifest(
      renderWorkstreamResourceManifest(manifest),
      manifest.workstreamId,
    )).toEqual(manifest);
  });

  it("rejects duplicate resource identities even when their roles differ", () => {
    const primary = manifestResource("primary", true);
    expect(() => renderWorkstreamResourceManifest({
      schema: "ayati.workstream-resources/v1",
      workstreamId: "W-20260719-0001",
      updatedAt: "2026-07-19T10:05:00+05:30",
      resources: [
        primary,
        { ...primary, role: "deliverable", primary: false },
      ],
    })).toThrow("duplicate resource");
  });

  it("rejects relative filesystem locators in the durable resource ledger", () => {
    const resource = manifestResource("primary", true);
    expect(() => renderWorkstreamResourceManifest({
      schema: "ayati.workstream-resources/v1",
      workstreamId: "W-20260719-0001",
      updatedAt: "2026-07-19T10:05:00+05:30",
      resources: [{
        ...resource,
        locator: { kind: "filesystem", path: "rust-examples" },
      }],
    })).toThrow("invalid resource entry");
  });

  it("stores a compact per-run summary in finalization commit metadata", () => {
    const message = renderWorkstreamCommit({
      subject: "update example output (r-0001): incomplete",
      workstreamId: "W-20260719-0001",
      workstreamTitle: "Example output",
      requestId: "R-0001",
      requestTitle: "Update example output",
      requestStatusAfter: "active",
      runId: "R-20260719-0001",
      streamId: "AST-1234567890ABCDEF12345678",
      outcome: "incomplete",
      stopReason: "run_limit",
      validation: "passed",
      criteria: { passed: 2, total: 3 },
      resourceEffects: {
        created: 1,
        modified: 1,
        moved: 0,
        deleted: 0,
        restored: 0,
        downloaded: 0,
        external_state_changed: 0,
      },
      mutationDetails: [{
        type: "created",
        resourceId: "RES-1234567890ABCDEF12345678",
        summary: "Created the example file.",
      }, {
        type: "modified",
        resourceId: "RES-ABCDEF1234567890ABCDEF12",
        summary: "Updated the example index.",
      }],
      problemCodes: ["VALIDATION_PENDING"],
      summary: "Built the first two examples and verified both.",
      next: "Build the third borrowing example.",
      messageHash: "sha256:" + "a".repeat(64),
      mutations: 2,
    });
    expect(parseWorkstreamCommit(message)).toMatchObject({
      event: "workstream_bound_run_finalized",
      streamId: "AST-1234567890ABCDEF12345678",
      summary: "Built the first two examples and verified both.",
      next: "Build the third borrowing example.",
      mutations: 2,
      requestStatusAfter: "active",
      stopReason: "run_limit",
      validation: "passed",
      criteria: { passed: 2, total: 3 },
      mutationDetails: [{
        type: "created",
        resourceId: "RES-1234567890ABCDEF12345678",
      }, {
        type: "modified",
        resourceId: "RES-ABCDEF1234567890ABCDEF12",
      }],
      problemCodes: ["VALIDATION_PENDING"],
      schema: "workstream-commit/v1",
    });
  });

  it("continues to parse legacy workstream commit metadata", () => {
    expect(parseWorkstreamCommit([
      "finalize r-0001 run",
      "",
      "Workstream: W-20260719-0001",
      "Request: R-0001",
      "Run: RUN-12345678-0000000001",
      "Agent-Stream: AST-1234567890ABCDEF12345678",
      "Outcome: incomplete",
      "Validation: not_applicable",
      "Summary: Continue the existing request.",
      `Message-Hash: sha256:${"a".repeat(64)}`,
      "Ayati-Schema: workstream/v3",
      "Ayati-Event: workstream_bound_run_finalized",
      "",
      "Ayati-Workstream: W-20260719-0001",
      "Ayati-Request: R-0001",
      "Ayati-Run: RUN-12345678-0000000001",
      "Ayati-Outcome: incomplete",
      "Ayati-Mutations: 0",
    ].join("\n"))).toMatchObject({
      schema: "workstream/v3",
      outcome: "incomplete",
      mutationDetails: [],
      problemCodes: [],
    });
  });

  it("accepts finalization-sized summary and next fields in commit metadata", () => {
    const summary = "s".repeat(2_000);
    const next = "n".repeat(1_000);
    const message = renderWorkstreamCommit({
      subject: "record bounded finalization metadata",
      workstreamId: "W-20260719-0001",
      requestId: "R-0001",
      runId: "RUN-12345678-0000000001",
      streamId: "AST-1234567890ABCDEF12345678",
      outcome: "incomplete",
      validation: "not_applicable",
      summary,
      next,
      messageHash: "sha256:" + "a".repeat(64),
      mutations: 0,
    });

    expect(parseWorkstreamCommit(message)).toMatchObject({ summary, next });
  });
});

function manifestResource(role: "primary" | "deliverable", primary: boolean) {
  return {
    resourceId: "RES-1234567890ABCDEF12345678",
    kind: "directory" as const,
    origin: "agent_created" as const,
    role,
    access: "mutate" as const,
    primary,
    requestIds: ["R-0001"],
    displayName: "rust-examples",
    description: "User-visible Rust practice output.",
    aliases: ["examples"],
    locator: { kind: "filesystem" as const, path: "/tmp/rust-examples" },
    version: {
      key: "directory:abc",
      observedAt: "2026-07-19T10:05:00+05:30",
      exists: true,
      kind: "directory" as const,
      fingerprint: "abc",
      entryCount: 1,
      sizeBytes: 0,
    },
    availability: "available" as const,
    lastUsedAt: "2026-07-19T10:05:00+05:30",
  };
}
