import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRunResources,
  buildVerifiedCompletionResources,
} from "../../src/ivec/agent-runner/run-result.js";
import type { LoopState } from "../../src/ivec/types.js";

describe("verified completion resources", () => {
  it("uses bounded semantic metadata proposed for an exact verified output", () => {
    const path = "/var/tmp/semantic-site/index.html";
    const state = {
      virtualMode: {
        active: "validation",
        revision: 2,
        operational: true,
        capabilities: ["task:validation"],
        targets: [path],
        mutationScopes: [],
        validation: {
          returnMode: "execute",
          status: "passed",
          checks: [{
            kind: "file.written",
            subject: path,
            expectedKind: "file",
            actualKind: "file",
            status: "passed",
          }],
          resourceMetadata: [{
            path,
            displayName: "Lumen Finch home page",
            description: "The public HTML entry point for the Lumen Finch website.",
            aliases: ["homepage", "landing page"],
          }],
        },
      },
      completedSteps: [{
        step: 1,
        status: "success",
        summary: "Created the home page.",
        toolsUsed: ["write_files"],
        artifacts: [path],
        evidence: [],
      }],
    } as unknown as LoopState;

    expect(buildVerifiedCompletionResources(state)).toEqual([
      expect.objectContaining({
        displayName: "Lumen Finch home page",
        description: "The public HTML entry point for the Lumen Finch website.",
        aliases: [
          "homepage",
          "landing page",
          "Lumen Finch home page",
          "index.html",
        ],
        metadataStatus: "enriched",
        locator: { kind: "filesystem", path },
      }),
    ]);
  });

  it("records a shared project directory with described absolute file resources", () => {
    const site = "/var/tmp/lumen-finch";
    const paths = [
      join(site, "index.html"),
      join(site, "styles.css"),
      join(site, "script.js"),
    ];
    const state = {
      virtualMode: {
        active: "validation",
        revision: 2,
        operational: true,
        capabilities: ["task:validation"],
        targets: paths,
        mutationScopes: [],
        validation: {
          returnMode: "execute",
          status: "passed",
          checks: paths.map((path) => ({
            kind: "path.exists",
            subject: path,
            expectedKind: "file",
            actualKind: "file",
            status: "passed",
          })),
        },
      },
      completedSteps: [{
        step: 1,
        status: "success",
        summary: "Created the website files.",
        toolsUsed: ["write_files"],
        artifacts: paths,
        evidence: [],
      }],
    } as unknown as LoopState;

    const resources = buildVerifiedCompletionResources(state);

    expect(resources).toEqual([
      expect.objectContaining({
        kind: "directory",
        description: "Validated project directory lumen-finch.",
        aliases: ["lumen-finch"],
        metadataStatus: "fallback",
        locator: { kind: "filesystem", path: site },
      }),
      ...paths.map((path) => expect.objectContaining({
        kind: "file",
        description: `Validated agent-created file ${path.split("/").pop()}.`,
        aliases: [
          path.split("/").pop(),
          path.split("/").pop()?.split(".")[0],
        ],
        metadataStatus: "fallback",
        locator: { kind: "filesystem", path },
      })),
    ]);
  });

  it("preserves existing resource identity and metadata for an unchanged desired-state write", () => {
    const path = "/var/tmp/existing-site/index.html";
    const state = {
      virtualMode: {
        active: "validation",
        revision: 2,
        operational: true,
        capabilities: ["task:validation"],
        targets: [path],
        mutationScopes: [],
        validation: {
          returnMode: "execute",
          status: "passed",
          checks: [{
            kind: "path.exists",
            subject: path,
            expectedKind: "file",
            actualKind: "file",
            status: "passed",
          }],
        },
      },
      completedSteps: [{
        step: 1,
        outcome: "success",
        summary: "Confirmed the requested file content.",
        toolsUsed: ["write_files"],
        artifacts: [path],
        newFacts: [],
        toolSuccessCount: 1,
        toolFailureCount: 0,
      }],
      toolContext: {
        toolCalls: [{
          step: 1,
          callId: "write-existing",
          tool: "write_files",
          input: { files: [{ path, content: "current" }] },
          status: "success",
          output: "Already current.",
          completionEvidence: [{
            kind: "path_state",
            path,
            exists: true,
            actualKind: "file",
            change: "observed",
            operation: "write",
            writeStatus: "unchanged",
            tool: "write_files",
            step: 1,
            callId: "write-existing",
          }],
        }],
      },
      harnessContext: {
        contextEngine: {
          workstream: {
            resources: [{
              role: "reference",
              access: "mutate",
              primary: true,
              resource: {
                resourceId: "RES-EXISTING",
                kind: "file",
                origin: "user_reference",
                displayName: "Existing home page",
                description: "The user's existing website home page.",
                aliases: ["home page", "index"],
                locator: { kind: "filesystem", path },
                metadataStatus: "enriched",
              },
            }],
          },
        },
      },
    } as unknown as LoopState;

    const resources = buildRunResources(state);

    expect(resources).toEqual([
      expect.objectContaining({
        resourceId: "RES-EXISTING",
        role: "deliverable",
        origin: "user_reference",
        displayName: "Existing home page",
        description: "The user's existing website home page.",
        aliases: [
          "home page",
          "index",
          "Existing home page",
          "index.html",
        ],
        metadataStatus: "enriched",
        locator: { kind: "filesystem", path },
      }),
    ]);
  });

  it("preserves resource identity while relocating a moved file", () => {
    const source = "/var/tmp/site/old-name.txt";
    const destination = "/var/tmp/site/new-name.txt";
    const state = {
      virtualMode: {
        active: "validation",
        revision: 2,
        operational: true,
        capabilities: ["task:validation"],
        targets: [destination],
        mutationScopes: [],
        validation: {
          returnMode: "execute",
          status: "passed",
          checks: [{
            kind: "path.moved_to",
            subject: destination,
            expectedKind: "file",
            actualKind: "file",
            status: "passed",
          }],
        },
      },
      completedSteps: [{
        step: 1,
        outcome: "success",
        summary: "Moved the file.",
        toolsUsed: ["move"],
        artifacts: [destination],
        newFacts: [],
        toolSuccessCount: 1,
        toolFailureCount: 0,
      }],
      toolContext: {
        toolCalls: [{
          step: 1,
          callId: "move-file",
          tool: "move",
          input: { source, destination },
          status: "success",
          output: "Moved.",
          completionEvidence: [
            {
              kind: "path_state",
              path: source,
              exists: false,
              actualKind: "file",
              change: "mutated",
              operation: "move",
              tool: "move",
              step: 1,
              callId: "move-file",
            },
            {
              kind: "path_state",
              path: destination,
              exists: true,
              actualKind: "file",
              change: "mutated",
              operation: "move",
              tool: "move",
              step: 1,
              callId: "move-file",
            },
          ],
        }],
      },
      harnessContext: {
        contextEngine: {
          workstream: {
            resources: [{
              role: "reference",
              access: "mutate",
              primary: true,
              resource: {
                resourceId: "RES-MOVED",
                kind: "file",
                origin: "user_reference",
                displayName: "Project notes",
                description: "The existing project notes.",
                aliases: ["project notes"],
                locator: { kind: "filesystem", path: source },
                metadataStatus: "enriched",
              },
            }],
          },
        },
      },
    } as unknown as LoopState;

    const resources = buildRunResources(state);

    expect(resources).toEqual([
      expect.objectContaining({
        resourceId: "RES-MOVED",
        role: "deliverable",
        origin: "user_reference",
        displayName: "Project notes",
        description: expect.stringContaining(
          `Moved file Project notes from ${source}.`,
        ),
        aliases: expect.arrayContaining([
          "project notes",
          "Project notes",
          "new-name.txt",
          "old-name.txt",
        ]),
        metadataStatus: "enriched",
        locator: { kind: "filesystem", path: destination },
      }),
    ]);
  });
});
