import { describe, expect, it, vi } from "vitest";
import type { ContextEngineMachineContext } from "../../src/context-engine/index.js";
import {
  buildVirtualCapabilitySummary,
  collectVirtualModeTargetEvidence,
  directResponseRepair,
  dispatchVirtualModeTransition,
} from "../../src/ivec/agent-runner/virtual-mode-runtime.js";
import {
  createEntryVirtualModeState,
  type ModeTransitionRequest,
} from "../../src/ivec/agent-runner/virtual-mode.js";
import { findUnverifiedVirtualModeTargets } from "../../src/ivec/agent-runner/virtual-mode-targets.js";
import { buildRecentFilesHotContextEntry } from "../../src/ivec/hot-context/index.js";
import { CapabilitySurfaceManager } from "../../src/ivec/agent-runner/capabilities/surface-manager.js";
import { ToolRegistry } from "../../src/ivec/agent-runner/capabilities/registry.js";
import { deriveTurnMutationConstraints } from "../../src/ivec/agent-runner/turn-intent-policy.js";
import { buildFinalFeedbackWarnings } from "../../src/ivec/agent-runner/runner-feedback.js";
import type { LoopState } from "../../src/ivec/types.js";
import { createToolExecutor } from "../../src/skills/tool-executor.js";
import type { ToolDefinition } from "../../src/skills/types.js";
import { contextEngineFixture } from "../fixtures/agent-context.js";

const READ_TOOL = tool("read_files");
const INSPECT_TOOL = tool("inspect_paths");
const FIND_TOOL = tool("find_files");
const SEARCH_TOOL = tool("search_in_files");
const PATCH_TOOL = tool("patch_files");
const WRITE_TOOL = tool("write_files");
const CREATE_TOOL = tool("create_directory");
const SYSTEM_TIME_TOOL = tool("system_time");
const SYSTEM_HEALTH_TOOL = tool("system_health");
const DB_QUERY_TOOL = tool("db_query");
const FIND_WORKSTREAMS_TOOL = tool("git_context_find_workstreams");
const READ_WORKSTREAM_TOOL = tool("git_context_read_workstream");
const FIND_RESOURCES_TOOL = tool("git_context_find_resources");
const READ_TOOLS = [INSPECT_TOOL, READ_TOOL];
const WRITE_TOOLS = [CREATE_TOOL, WRITE_TOOL, PATCH_TOOL];

describe("virtual mode runtime", () => {
  it("builds a compact exact capability catalog without an inferred selector", () => {
    expect(buildVirtualCapabilitySummary([...READ_TOOLS, ...WRITE_TOOLS])).toBe(
      [
        "- file:read: Inspect exact paths and read file contents.",
        "- file:write: Create directories and write or patch files.",
        "- task:validation: Check important verified current-run responsibility outcomes before the final response.",
      ].join("\n"),
    );
  });

  it("accepts a canonical capability advertised by the explicit catalog", async () => {
    const tools = READ_TOOLS;
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry(tools),
      toolExecutor: createToolExecutor([]),
      validateCoverage: false,
    });
    const current = state("Read /tmp/known.md and summarize it.");

    expect(manager.getCapabilitySummary(current, { runId: current.runId })).toContain(
      "- file:read: Inspect exact paths and read file contents.",
    );
    const result = await dispatchVirtualModeTransition({
      state: current,
      request: {
        to: "observe.investigate",
        purpose: "Read the exact requested file.",
        capabilities: ["file:read"],
        targets: ["/tmp/known.md"],
      },
      workspaceRoot: "/tmp",
      iteration: 1,
      toolDefinitions: [],
      capabilitySurfaceManager: manager,
      toolContext: { runId: current.runId, stepNumber: 1 },
      bindingAlreadyAttempted: false,
      applyContext(context) {
        current.harnessContext.contextEngine = context;
      },
    });

    expect(result).toMatchObject({
      kind: "applied",
      active: "observe.investigate",
      toolNames: ["inspect_paths", "read_files"],
    });
  });

  it("allows an exact filesystem read target without prior grounding evidence", async () => {
    const known = state("Read /tmp/known.md and summarize it.");
    const accepted = await transition(known, {
      to: "observe.investigate",
      purpose: "Read the exact requested file.",
      capabilities: ["file:read"],
      targets: ["/tmp/known.md"],
    }, READ_TOOLS);
    expect(accepted).toMatchObject({ kind: "applied", active: "observe.investigate" });

    const earlierConversationPath = await transition(state("Read that same file again."), {
      to: "observe.investigate",
      purpose: "Read the exact file path retained from recent conversation.",
      capabilities: ["file:read"],
      references: [{ kind: "filesystem", path: "/tmp/earlier-conversation.md" }],
    }, READ_TOOLS);
    expect(earlierConversationPath).toMatchObject({
      kind: "applied",
      active: "observe.investigate",
      toolNames: ["inspect_paths", "read_files"],
    });
  });

  it("keeps exact target grounding mandatory for filesystem mutations", async () => {
    const current = state("Update the existing output file.");
    current.harnessContext.contextEngine = boundContext(
      current.harnessContext.contextEngine!,
    );

    const result = await transition(current, {
      to: "execute",
      purpose: "Update an ungrounded mutation target.",
      capabilities: ["file:write"],
      mutationScopes: [{
        kind: "filesystem",
        path: "/tmp/ungrounded-output.txt",
      }],
    }, WRITE_TOOLS);

    expect(result).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_TARGET_UNVERIFIED",
        blockedTargets: ["/tmp/ungrounded-output.txt"],
      },
    });
  });

  it("keeps prior grounding mandatory outside direct filesystem reads", async () => {
    const resourceId = "RES-AAAAAAAAAAAAAAAAAAAAAAAA";
    const resourceRead = await transition(state("Read the relevant resource."), {
      to: "observe.investigate",
      purpose: "Read an ungrounded resource identity.",
      capabilities: ["file:read"],
      references: [{ kind: "resource", resourceId }],
    }, READ_TOOLS);
    expect(resourceRead).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_TARGET_UNVERIFIED",
        blockedTargets: [resourceId],
      },
    });

    const databaseRead = await transition(state("Inspect the relevant database."), {
      to: "observe.investigate",
      purpose: "Query an ungrounded database resource.",
      capabilities: ["database:read"],
      references: [{ kind: "resource", resourceId }],
    }, [DB_QUERY_TOOL]);

    expect(databaseRead).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_TARGET_UNVERIFIED",
        blockedTargets: [resourceId],
      },
    });
  });

  it("allows targetless system observations while retaining targets for file reads", async () => {
    const time = await transition(state("What time is it?"), {
      to: "observe.investigate",
      purpose: "Observe the current configured time.",
      capabilities: ["system:time"],
    }, [SYSTEM_TIME_TOOL]);
    expect(time).toMatchObject({
      kind: "applied",
      active: "observe.investigate",
      toolNames: ["system_time"],
    });

    const health = await transition(state("Is the machine healthy?"), {
      to: "observe.investigate",
      purpose: "Observe current local system health.",
      capabilities: ["system:health"],
    }, [SYSTEM_HEALTH_TOOL]);
    expect(health).toMatchObject({
      kind: "applied",
      active: "observe.investigate",
      toolNames: ["system_health"],
    });

    const fileWithoutReference = await transition(
      state("Read the relevant file."),
      {
        to: "observe.investigate",
        purpose: "Read an exact file.",
        capabilities: ["file:read"],
      },
      READ_TOOLS,
    );
    expect(fileWithoutReference).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_TARGET_REQUIRED" },
    });

    const mixedWithoutReference = await transition(
      state("Read the file and tell me the time."),
      {
        to: "observe.investigate",
        purpose: "Read a file and observe current time.",
        capabilities: ["system:time", "file:read"],
      },
      [...READ_TOOLS, SYSTEM_TIME_TOOL],
    );
    expect(mixedWithoutReference).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_TARGET_REQUIRED" },
    });
  });

  it("rejects context retrieval when no unloaded Hot Context is available", async () => {
    const current = state("Continue.");
    const result = await transition(current, {
      to: "context.retrieve",
      purpose: "Load optional personal context.",
      capabilities: ["context:load"],
    }, [tool("context_load")]);

    expect(result).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_NO_PROGRESS",
        message: "No unloaded Hot Context entry is currently available.",
      },
    });
  });

  it("enters proof-only validation and passes from verified current-run read evidence", async () => {
    const current = observationState();
    current.workState.status = "done";
    current.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "read-known",
        tool: "read_files",
        input: { files: [{ path: "/tmp/known.md" }] },
        status: "success",
        output: "known contents",
        verificationPassed: true,
        completionEvidence: [{
          kind: "file_read",
          path: "/tmp/known.md",
          requestedPath: "/tmp/known.md",
          coverage: "complete",
          contentAvailable: true,
          change: "observed",
          tool: "read_files",
          step: 1,
          callId: "read-known",
        }],
      }],
    };
    const result = await transition(current, {
      to: "validation",
      purpose: "Check completion proof for the important requested file.",
      capabilities: ["task:validation"],
      validationChecks: [{
        kind: "file.read_complete",
        subject: "/tmp/known.md",
        expectedKind: "file",
      }],
    }, []);

    expect(result).toMatchObject({
      kind: "applied",
      active: "validation",
      toolNames: [],
    });
    expect(current.virtualMode).toMatchObject({
      active: "validation",
      validation: {
        returnMode: "observe.investigate",
        status: "passed",
        checks: [{
          kind: "file.read_complete",
          subject: "/tmp/known.md",
          expectedKind: "file",
          status: "passed",
          satisfiedBy: {
            step: 1,
            callId: "read-known",
            tool: "read_files",
          },
        }],
      },
    });
    expect(directResponseRepair(current)).toBeUndefined();

    current.workState.status = "in_progress";
    current.workState.plan = [{
      id: "confirm-summary",
      task: "Confirm the requested summary is complete.",
      status: "active",
    }];
    expect(directResponseRepair(current)).toMatchObject({
      code: "VALIDATION_REJECTED",
      blockedTargets: ["Confirm the requested summary is complete."],
    });
  });

  it("requires absolute filesystem references in typed mode requests", async () => {
    const result = await transition(state("Read /tmp/known.md and summarize it."), {
      to: "observe.investigate",
      purpose: "Read the requested file.",
      capabilities: ["file:read"],
      references: [{ kind: "filesystem", path: "known.md" }],
    }, READ_TOOLS);

    expect(result).toMatchObject({
      kind: "rejected",
      repair: {
        code: "MODE_INPUT_INVALID",
        blockedTargets: ["known.md"],
      },
    });
  });

  it("keeps directory grounding bounded without using it as file-read admission", async () => {
    const current = state("Inspect the attached website directory.");
    current.harnessContext.contextEngine!.ingressResources = [{
      resourceId: "RES-111111111111111111111111",
      kind: "directory",
      origin: "user_attachment",
      displayName: "website",
      description: "Attached website directory",
      aliases: [],
      locator: { kind: "filesystem", path: "/tmp/authorized-site" },
      version: {
        key: "directory:website",
        observedAt: "2026-07-22T12:00:00.000Z",
        exists: true,
        kind: "directory",
        entryCount: 0,
      },
      availability: "available",
      metadataStatus: "enriched",
      createdAt: "2026-07-22T12:00:00.000Z",
      updatedAt: "2026-07-22T12:00:00.000Z",
    }];
    const childPath = "/tmp/authorized-site/index.html";
    const siblingPath = "/tmp/authorized-site-other/index.html";

    await expect(findUnverifiedVirtualModeTargets(current, [childPath]))
      .resolves.toEqual([]);
    await expect(findUnverifiedVirtualModeTargets(current, [siblingPath]))
      .resolves.toEqual([siblingPath]);
    await expect(transition(current, {
      to: "observe.investigate",
      purpose: "Inspect a child in the admitted directory.",
      capabilities: ["file:read"],
      references: [{ kind: "filesystem", path: childPath }],
    }, READ_TOOLS)).resolves.toMatchObject({ kind: "applied" });

    const sibling = state("Inspect the attached website directory.");
    sibling.harnessContext.contextEngine!.ingressResources = current.harnessContext.contextEngine!.ingressResources;
    await expect(transition(sibling, {
      to: "observe.investigate",
      purpose: "Let the read tool validate a sibling outside the admitted directory.",
      capabilities: ["file:read"],
      references: [{ kind: "filesystem", path: siblingPath }],
    }, READ_TOOLS)).resolves.toMatchObject({
      kind: "applied",
      active: "observe.investigate",
    });
  });

  it("allows successful locate evidence to ground a later investigation target", async () => {
    const current = state("Find the requested notes file in the workspace.");
    current.virtualMode = {
      active: "observe.locate",
      revision: 1,
      operational: true,
      purpose: "Find the notes file.",
      capabilities: ["file:search"],
      targets: [],
      enteredAtIteration: 1,
    };
    current.toolContext = {
      recent: [],
      toolCalls: [{
        step: 1,
        callId: "find-1",
        tool: "find_files",
        purpose: "Find the notes file",
        input: { query: "notes" },
        status: "success",
        output: "/tmp/discovered-notes.md",
      }],
    };

    expect(collectVirtualModeTargetEvidence(current)).toContain("/tmp/discovered-notes.md");
    await expect(transition(current, {
      to: "observe.investigate",
      purpose: "Read the located notes file.",
      capabilities: ["file:read"],
      targets: ["/tmp/discovered-notes.md"],
    }, READ_TOOLS)).resolves.toMatchObject({
      kind: "applied",
      active: "observe.investigate",
    });
  });

  it("uses loaded recent-file metadata only to ground read-only investigation", async () => {
    const path = "/tmp/archive/lumen-garden-field-brief.txt";
    const current = state("What else did that same file say?");
    const entry = buildRecentFilesHotContextEntry([{
      name: "lumen-garden-field-brief.txt",
      path,
      lastReadAt: "2026-07-25T08:21:08.000Z",
      evidenceRef: "run:RUN-OLD:step:2:call:call-read",
      coverage: "complete",
      status: "navigation_only",
      requestSeq: 19,
      responseSeq: 20,
    }])!;
    current.hotContext = {
      available: [],
      loaded: [{ ...entry, mountedAtStep: 0 }],
      budget: {
        maxMountedTokens: 8_000,
        mountedTokens: entry.estimatedTokens,
      },
    };

    expect(collectVirtualModeTargetEvidence(current)).not.toContain(path);
    await expect(findUnverifiedVirtualModeTargets(current, [path]))
      .resolves.toEqual([path]);
    await expect(findUnverifiedVirtualModeTargets(current, [path], {
      includeRecentFileNavigation: true,
    })).resolves.toEqual([]);
    await expect(transition(current, {
      to: "observe.investigate",
      purpose: "Read the exact recent file again for current contents.",
      capabilities: ["file:read"],
      references: [{ kind: "filesystem", path }],
    }, READ_TOOLS)).resolves.toMatchObject({
      kind: "applied",
      active: "observe.investigate",
    });
    expect(current.virtualMode.targets).toEqual([path]);
  });

  it("uses an always-visible active-document pointer only to ground read-only investigation", async () => {
    const path = "/tmp/archive/active-field-brief.txt";
    const current = state("What else did that same file say?");
    current.harnessContext.contextEngine!.agentStream.recentFiles = [{
      name: "active-field-brief.txt",
      path,
      lastReadAt: "2026-07-26T08:21:08.000Z",
      evidenceRef: "run:RUN-OLD:step:2:call:call-read",
      coverage: "complete",
      status: "navigation_only",
      requestSeq: 19,
      responseSeq: 20,
    }];

    expect(collectVirtualModeTargetEvidence(current)).not.toContain(path);
    await expect(findUnverifiedVirtualModeTargets(current, [path]))
      .resolves.toEqual([path]);
    await expect(findUnverifiedVirtualModeTargets(current, [path], {
      includeRecentFileNavigation: true,
    })).resolves.toEqual([]);
    await expect(transition(current, {
      to: "observe.investigate",
      purpose: "Read the active document again for current contents.",
      capabilities: ["file:read"],
      references: [{ kind: "filesystem", path }],
    }, READ_TOOLS)).resolves.toMatchObject({
      kind: "applied",
      active: "observe.investigate",
    });
  });

  it("rejects a mutation capability in an observation mode", async () => {
    const current = state("Find config.ts before changing it.");
    const result = await transition(current, {
      to: "observe.locate",
      purpose: "Locate the configuration source.",
      capabilities: ["file:write"],
    }, [FIND_TOOL, SEARCH_TOOL, ...READ_TOOLS, ...WRITE_TOOLS]);

    expect(result).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_CAPABILITY_FORBIDDEN" },
    });
  });

  it("enters control-only workstream routing after current-run ownership observation", async () => {
    const current = observedWorkstreamState("Create output.txt.");
    const tools = [FIND_WORKSTREAMS_TOOL, READ_WORKSTREAM_TOOL, FIND_RESOURCES_TOOL];
    const manager = new CapabilitySurfaceManager({
      registry: new ToolRegistry(tools),
      toolExecutor: createToolExecutor([]),
      validateCoverage: false,
    });
    const toolContext = { runId: current.runId, stepNumber: 2 };
    manager.replaceWithCapabilities({
      capabilities: ["workstream:search"],
      mode: "observe.locate",
      state: current,
      context: toolContext,
    });
    expect(manager.listActive(toolContext)).toEqual(["git_context_find_workstreams"]);

    const result = await dispatchVirtualModeTransition({
      state: current,
      request: {
        to: "workstream.route",
        purpose: "Select the verified durable owner before creating the file.",
        capabilities: [],
      },
      workspaceRoot: "/tmp",
      iteration: 2,
      toolDefinitions: tools,
      capabilitySurfaceManager: manager,
      toolContext,
      bindingAlreadyAttempted: false,
      applyContext(context) {
        current.harnessContext.contextEngine = context;
      },
    });

    expect(result).toMatchObject({
      kind: "applied",
      active: "workstream.route",
      toolNames: [],
      loadResult: {
        evicted: ["git_context_find_workstreams"],
      },
    });
    expect(manager.listActive(toolContext)).toEqual([]);
    expect(current.virtualMode).toMatchObject({
      active: "workstream.route",
      capabilities: [],
      targets: [],
    });
  });

  it("does not expose workstream routing before a current-run ownership observation", async () => {
    const result = await transition(state("Create output.txt."), {
      to: "workstream.route",
      purpose: "Try to route before observing durable ownership.",
      capabilities: [],
    }, [FIND_WORKSTREAMS_TOOL, READ_WORKSTREAM_TOOL, FIND_RESOURCES_TOOL]);

    expect(result).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_EDGE_PROHIBITED" },
    });
  });

  it("returns from routing to workstream investigation without discarding current-run evidence", async () => {
    const current = workstreamRoutingState("Update W-20260722-0001.");
    current.toolContext!.toolCalls![0]!.output = JSON.stringify({
      workstreams: [{
        workstreamId: "W-20260722-0001",
        head: "a".repeat(40),
        discovery: {
          tier: "definite",
          reasons: ["exact_workstream_id"],
        },
      }],
      count: 1,
    });

    const result = await transition(current, {
      to: "observe.investigate",
      purpose: "Inspect the exact workstream before selecting its request.",
      capabilities: ["workstream:read"],
      references: [{
        kind: "workstream",
        workstreamId: "W-20260722-0001",
      }],
    }, [READ_WORKSTREAM_TOOL]);

    expect(result).toMatchObject({
      kind: "applied",
      active: "observe.investigate",
      toolNames: ["git_context_read_workstream"],
    });
    expect(current.toolContext?.toolCalls).toHaveLength(1);
  });

  it("prohibits direct unbound resolve before workstream routing", async () => {
    const result = await transition(state("Create /tmp/output.txt."), {
      to: "resolve",
      purpose: "Try to bind before routing.",
      capabilities: ["file:write"],
      workspaceTargets: [{ kind: "file", relativePath: "output.txt" }],
      binding: {
        kind: "create",
        title: "Create output file",
        objective: "Create the requested output.",
        initialRequest: {
          title: "Create output",
          request: "Create /tmp/output.txt.",
          acceptance: ["The requested file exists."],
          constraints: [],
        },
      },
    }, WRITE_TOOLS);

    expect(result).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_EDGE_PROHIBITED" },
    });
  });

  it("requires mutation intent and a binding-required capability at resolve", async () => {
    const readOnly = await transition(
      workstreamRoutingState("Inspect /tmp/output.txt; do not modify anything."),
      {
      to: "resolve",
      purpose: "Try to write despite the read-only request.",
      capabilities: ["file:write"],
      targets: ["/tmp/output.txt"],
      },
      WRITE_TOOLS,
    );
    expect(readOnly).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_MUTATION_INTENT_REQUIRED" },
    });

    const observationalCapability = await transition(workstreamRoutingState("Create /tmp/output.txt."), {
      to: "resolve",
      purpose: "Resolve with a read-only capability.",
      capabilities: ["file:read"],
      targets: ["/tmp/output.txt"],
    }, READ_TOOLS);
    expect(observationalCapability).toMatchObject({
      kind: "rejected",
      repair: { code: "MODE_CAPABILITY_FORBIDDEN" },
    });
  });

  it("resolves once and enters execute mechanically after authoritative binding", async () => {
    const current = workstreamRoutingState("Create /tmp/output.txt.");
    const bound = boundContext(current.harnessContext.contextEngine!);
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "resolved" as const,
        kind: "created_workstream" as const,
        workstreamId: "W-20260722-0001",
        requestId: "R-1",
        context: bound,
      })),
    };

    const result = await dispatchVirtualModeTransition({
      state: current,
      request: {
        to: "resolve",
        purpose: "Bind the exact output before writing.",
        capabilities: ["file:write"],
        workspaceTargets: [{ kind: "file", relativePath: "output.txt" }],
        binding: {
          kind: "create",
          title: "Create output file",
          objective: "Create the exact output requested by the user.",
          initialRequest: {
            title: "Create output",
            request: "Create /tmp/output.txt.",
            acceptance: ["The requested file exists."],
            constraints: [],
          },
        },
      },
      workspaceRoot: "/tmp",
      iteration: 1,
      toolDefinitions: WRITE_TOOLS,
      toolContext: { runId: "RUN-1", stepNumber: 1 },
      workstreamBinding: coordinator,
      bindingAlreadyAttempted: false,
      applyContext(context) {
        current.harnessContext.contextEngine = context;
      },
    });

    expect(result).toMatchObject({
      kind: "resolved",
      active: "execute",
      toolNames: ["create_directory", "write_files", "patch_files"],
    });
    expect(coordinator.bind).toHaveBeenCalledOnce();
    expect(current.virtualMode).toMatchObject({
      active: "execute",
      revision: 3,
      capabilities: ["file:write"],
      targets: ["output.txt"],
      mutationScopes: ["/tmp/output.txt"],
    });
  });

  it("activates an existing workstream from routed resource IDs without model-authored scopes", async () => {
    const resourceId = "RES-0123456789ABCDEF01234567";
    const current = workstreamRoutingState("Update the existing balcony-herbs.md file.");
    current.toolContext!.toolCalls![0]!.output = JSON.stringify({
      workstreams: [{
        workstreamId: "W-20260722-0001",
        head: "a".repeat(40),
        currentRequest: { id: "R-0001", status: "done" },
        discovery: { tier: "definite", reasons: ["owned_resource"] },
      }],
      count: 1,
    });
    current.toolContext!.toolCalls!.push({
      step: 2,
      callId: "routing-resource",
      tool: "git_context_find_resources",
      purpose: "Find the exact existing herb-note resource.",
      input: { resourceIds: [resourceId] },
      status: "success",
      output: JSON.stringify({
        resources: [{
          resource: {
            resourceId,
            locator: {
              kind: "filesystem",
              path: "/tmp/balcony-herbs.md",
            },
          },
          workstreamIds: ["W-20260722-0001"],
        }],
        count: 1,
      }),
      evidenceRef: "evidence:routing-resource",
    });
    const coordinator = {
      bind: vi.fn(async () => ({
        status: "resolved" as const,
        kind: "activated_workstream" as const,
        workstreamId: "W-20260722-0001",
        requestId: "R-0002",
        context: boundContext(current.harnessContext.contextEngine!),
      })),
    };

    const result = await dispatchVirtualModeTransition({
      state: current,
      request: {
        to: "resolve",
        purpose: "Activate the existing herb-note workstream for this update.",
        capabilities: ["file:write"],
        binding: {
          kind: "activate",
          workstreamId: "W-20260722-0001",
          requestDecision: {
            kind: "create_and_activate",
            title: "Add rosemary guidance",
            request: "Add rosemary guidance to the existing note.",
            acceptance: ["The note contains rosemary sunlight and watering guidance."],
            constraints: ["Keep all existing content."],
            reason: "This is a separate outcome in the same herb-note project.",
          },
          resourceIds: [resourceId],
        },
      },
      workspaceRoot: "/tmp",
      iteration: 2,
      toolDefinitions: WRITE_TOOLS,
      toolContext: { runId: "RUN-1", stepNumber: 2 },
      workstreamBinding: coordinator,
      bindingAlreadyAttempted: false,
      applyContext(context) {
        current.harnessContext.contextEngine = context;
      },
    });

    expect(result).toMatchObject({
      kind: "resolved",
      active: "execute",
      toolNames: ["create_directory", "write_files", "patch_files"],
    });
    expect(coordinator.bind).toHaveBeenCalledWith(expect.objectContaining({
      expectedWorkstreamHead: "a".repeat(40),
      routingEvidence: ["evidence:routing-1", "evidence:routing-resource"],
      proposal: expect.objectContaining({
        resourceIds: [resourceId],
      }),
    }));
    expect(current.virtualMode.targets).toEqual([resourceId]);
    expect(current.virtualMode.mutationScopes).toEqual(["/tmp/balcony-herbs.md"]);
  });

  it("enters execute from ENTRY when the run is already authoritatively bound", async () => {
    const current = state("Update /tmp/output.txt.");
    current.harnessContext.contextEngine = boundContext(current.harnessContext.contextEngine!);

    const result = await transition(current, {
      to: "execute",
      purpose: "Use the existing authoritative binding to update the file.",
      capabilities: ["file:write"],
      targets: ["/tmp/output.txt"],
    }, WRITE_TOOLS);

    expect(result).toMatchObject({
      kind: "applied",
      active: "execute",
      toolNames: ["create_directory", "write_files", "patch_files"],
    });
    expect(current.virtualMode.active).toBe("execute");
  });

  it("allows every direct ENTRY reply while preserving the active-graph validation gate", () => {
    expect(directResponseRepair(state("Hello!"))).toBeUndefined();
    expect(directResponseRepair(state("What is Newton's first law?"))).toBeUndefined();
    expect(directResponseRepair(state("What is a file descriptor?"))).toBeUndefined();
    expect(directResponseRepair(state("How do I create a file in TypeScript?"))).toBeUndefined();
    expect(directResponseRepair(state("Where is France?"))).toBeUndefined();
    expect(directResponseRepair(state("Where is upload handling?"))).toBeUndefined();
    expect(directResponseRepair(state("Read /tmp/known.md."))).toBeUndefined();
    expect(directResponseRepair(state("Create /tmp/output.txt."))).toBeUndefined();
    expect(directResponseRepair(state(
      "Read exactly one of the two release-notes.txt files and tell me its coordinator.",
    ))).toBeUndefined();
    expect(buildFinalFeedbackWarnings({
      status: "completed",
      totalToolCalls: 0,
      modeTransitionCount: 0,
      failedVerificationCount: 0,
      state: state("Read exactly one of the two release-notes.txt files."),
    })).toEqual([]);

    const active = observationState();
    expect(directResponseRepair(active)).toMatchObject({
      code: "TERMINAL_REQUIRES_VALIDATION",
    });
  });

  it("retains explicit no-change language as an authoritative constraint", () => {
    expect(deriveTurnMutationConstraints("Inspect this file but do not modify anything.")).toEqual({
      mutationForbidden: true,
      observationalOnly: true,
      mutationRequested: false,
      observationRequested: true,
      scopePolicy: {
        allowedScopes: [],
        denyOutsideAllowedScopes: false,
      },
    });
    expect(deriveTurnMutationConstraints("Read the file, then edit the heading.")).toMatchObject({
      mutationForbidden: false,
      mutationRequested: true,
      observationRequested: true,
    });
    expect(deriveTurnMutationConstraints(
      "Build the website in /tmp/site. Do not modify anything outside /tmp/site.",
    )).toMatchObject({
      mutationForbidden: false,
      mutationRequested: true,
      scopePolicy: {
        allowedScopes: ["/tmp/site"],
        denyOutsideAllowedScopes: true,
      },
    });
  });
});

async function transition(
  current: LoopState,
  request: ModeTransitionRequest,
  toolDefinitions: ToolDefinition[],
) {
  return await dispatchVirtualModeTransition({
    state: current,
    request,
    workspaceRoot: "/tmp",
    iteration: current.iteration + 1,
    toolDefinitions,
    toolContext: { runId: current.runId, stepNumber: current.iteration + 1 },
    bindingAlreadyAttempted: false,
    applyContext(context) {
      current.harnessContext.contextEngine = context;
    },
  });
}

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object", properties: {} },
    async execute() {
      return { ok: true, output: `${name}-ok` };
    },
  };
}

function state(message: string): LoopState {
  const contextEngine = contextEngineFixture({ runId: "RUN-1", message });
  return {
    runId: "RUN-1",
    currentSeq: 1,
    inputKind: "user_message",
    userMessage: message,
    workState: {
      status: "in_progress",
      summary: "Run started.",
      plan: [],
      importantContext: [],
    },
    workStateRuntime: {
      revision: 0,
      afterStep: 0,
      updateReason: "initial",
    },
    status: "running",
    finalOutput: "",
    iteration: 0,
    maxIterations: 20,
    consecutiveFailures: 0,
    completedSteps: [],
    runPath: "",
    failureHistory: [],
    virtualMode: createEntryVirtualModeState(),
    hotContext: {
      available: [],
      loaded: [],
      budget: { maxMountedTokens: 8_000, mountedTokens: 0 },
    },
    harnessContext: {
      contextEngine: {
        ...contextEngine,
        current: {
          ...contextEngine.current,
          runId: "RUN-1",
          routing: { status: "unbound" },
        },
      },
    },
  };
}

function observationState(): LoopState {
  const current = state("Read /tmp/known.md.");
  current.virtualMode = {
    active: "observe.investigate",
    revision: 1,
    operational: true,
    purpose: "Read the exact file.",
    capabilities: ["file:read"],
    targets: ["/tmp/known.md"],
    enteredAtIteration: 1,
  };
  return current;
}

function workstreamRoutingState(message: string): LoopState {
  const current = observedWorkstreamState(message);
  current.virtualMode = {
    active: "workstream.route",
    revision: 1,
    operational: true,
    purpose: "Select the verified durable owner before mutation.",
    capabilities: [],
    targets: [],
    enteredAtIteration: 1,
  };
  return current;
}

function observedWorkstreamState(message: string): LoopState {
  const current = state(message);
  current.virtualMode = {
    active: "observe.locate",
    revision: 1,
    operational: true,
    purpose: "Find the durable owner before mutation.",
    capabilities: ["workstream:search"],
    targets: [message],
    enteredAtIteration: 1,
  };
  current.toolContext = {
    recent: [],
    toolCalls: [{
      step: 1,
      callId: "routing-1",
      tool: "git_context_find_workstreams",
      purpose: "Check existing ownership before creating a workstream.",
      input: { query: message },
      status: "success",
      output: JSON.stringify({ workstreams: [], count: 0 }),
      evidenceRef: "evidence:routing-1",
    }],
  };
  return current;
}

function boundContext(context: ContextEngineMachineContext): ContextEngineMachineContext {
  return {
    ...context,
    contextRevision: "ctx:bound",
    current: {
      ...context.current,
      routing: {
        status: "bound",
        workstreamId: "W-20260722-0001",
        requestId: "R-1",
      },
    },
  };
}
