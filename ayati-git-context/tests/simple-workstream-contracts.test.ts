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
      schema: "ayati.workstream/v2",
      id: "W-20260719-0001",
      title: "Learning Rust",
      status: "active",
      currentRequest: "R-0001",
      purpose: "Build durable Rust knowledge over multiple days.",
      currentSnapshot: "Ownership and borrowing are understood at an introductory level.",
      currentFocus: "Practice borrowing with three small examples.",
      blockers: [],
      workingAgreements: ["Keep external files in the resource catalog."],
    };
    const rendered = renderWorkstreamCard(card);
    expect(rendered).not.toContain("Important paths");
    expect(parseWorkstreamCard(rendered, card.id)).toEqual(card);
  });

  it("round-trips request context independently of deliverables", () => {
    const request = {
      schema: "ayati.request/v2" as const,
      id: "R-0001",
      title: "Practice borrowing",
      status: "active" as const,
      createdAt: "2026-07-19T10:00:00+05:30",
      source: "user" as const,
      request: "Create and explain three borrowing examples.",
      acceptance: ["All examples compile and are explained."],
      constraints: ["Keep each example small."],
      outcome: "Not completed yet.",
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

  it("stores a compact per-run summary in finalization commit metadata", () => {
    const message = renderWorkstreamCommit({
      subject: "finalize r-0001 run",
      workstreamId: "W-20260719-0001",
      requestId: "R-0001",
      runId: "R-20260719-0001",
      sessionId: "S-20260719-local",
      outcome: "incomplete",
      validation: "passed",
      summary: "Built the first two examples and verified both.",
      next: "Build the third borrowing example.",
    });
    expect(parseWorkstreamCommit(message)).toMatchObject({
      event: "workstream_bound_run_finalized",
      summary: "Built the first two examples and verified both.",
      next: "Build the third borrowing example.",
    });
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
