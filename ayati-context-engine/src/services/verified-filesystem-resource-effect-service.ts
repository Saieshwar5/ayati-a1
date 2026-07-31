import { basename } from "node:path";
import type {
  ResourceEvent,
  ResourceKind,
  ResourceOrigin,
  ResourceRef,
  ResourceVersion,
  VerifiedFilesystemResourceEffect,
  VerifiedFilesystemResourceEffectState,
  WorkstreamResourceBinding,
} from "../contracts.js";
import type { ContextDatabase } from "../database/database.js";
import { ContextEngineServiceError } from "../errors.js";
import {
  bindResourcesToWorkstream,
  mutationEligible,
  readResource,
  readResourceByLocator,
  readWorkstreamResourceBindings,
  recordResourceAccess,
  recordResourceObservation,
  upsertResource,
  type ObservedResourceAdmission,
} from "../repositories/resource-records.js";
import { relocateFilesystemResource } from "../repositories/resource-lifecycle-records.js";
import { observeResource, type ObservedResource } from "../resources/resource-observation.js";

export async function applyVerifiedFilesystemResourceEffects(input: {
  database: ContextDatabase;
  runId: string;
  workstreamId: string;
  requestId: string;
  effects: VerifiedFilesystemResourceEffect[];
  at: string;
}): Promise<WorkstreamResourceBinding[]> {
  await verifyFinalFilesystemStates(input.effects, input.at);
  const affected = new Map<string, {
    resource: ResourceRef;
    expectedState: VerifiedFilesystemResourceEffectState;
  }>();

  for (const effect of input.effects) {
    let applied: ResourceRef;
    switch (effect.operation) {
      case "moved":
        applied = await applyMove(input, effect);
        break;
      case "copied":
        applied = await applyCopy(input, effect);
        break;
      default:
        applied = await applyUnary(input, effect);
        break;
    }
    affected.set(applied.resourceId, {
      resource: applied,
      expectedState: finalStateForEffect(effect),
    });
  }

  for (const affectedResource of affected.values()) {
    const reconciled = await reconcileFinalState(input, affectedResource);
    affectedResource.resource = reconciled;
  }

  if (affected.size > 0) {
    input.database.transaction(() => bindResourcesToWorkstream(input.database, {
      runId: input.runId,
      workstreamId: input.workstreamId,
      requestId: input.requestId,
      bindings: [...affected.values()].map(({ resource }) => ({
        resourceId: resource.resourceId,
        role: "output",
        access: mutationEligible(resource) ? "mutate" : "read",
      })),
      at: input.at,
    }));
  }
  return readWorkstreamResourceBindings(input.database, input.workstreamId);
}

async function applyUnary(
  input: EffectServiceInput,
  effect: Extract<
    VerifiedFilesystemResourceEffect,
    { operation: "created" | "modified" | "permissions_changed" | "deleted" }
  >,
): Promise<ResourceRef> {
  const existing = readResourceByLocator(input.database, filesystemLocator(effect.path));
  if (effect.operation === "deleted" && existing?.availability === "deleted") {
    recordEffect(input, existing, effect, "deleted", existing.version, existing.version);
    return requireResource(input.database, existing.resourceId);
  }

  const beforeState = effect.before ?? defaultBeforeState(effect);
  const beforeResource = existing ?? await ensureResourceAtPath({
    ...input,
    effect,
    path: effect.path,
    state: beforeState,
    origin: effect.operation === "created" ? "agent_created" : "agent_discovered",
  });
  const beforeVersion = beforeResource.version;
  const afterState = effect.after ?? defaultAfterState(effect);
  const resource = await ensureResourceAtPath({
    ...input,
    effect,
    path: effect.path,
    state: afterState,
    origin: beforeResource.origin,
  });
  const eventType = resourceEventType(effect.operation, existing);
  recordEffect(
    input,
    resource,
    effect,
    eventType,
    beforeVersion,
    resource.version,
  );
  return requireResource(input.database, resource.resourceId);
}

async function applyCopy(
  input: EffectServiceInput,
  effect: Extract<VerifiedFilesystemResourceEffect, { operation: "copied" }>,
): Promise<ResourceRef> {
  const before = readResourceByLocator(
    input.database,
    filesystemLocator(effect.destinationPath),
  );
  const resource = await ensureResourceAtPath({
    ...input,
    effect,
    path: effect.destinationPath,
    state: effect.after ?? { exists: true, kind: effect.kind },
    origin: "agent_created",
  });
  const eventType: ResourceEvent["type"] = before
    && (before.availability === "deleted" || before.availability === "missing")
    ? "restored"
    : "created";
  recordEffect(
    input,
    resource,
    effect,
    eventType,
    before?.version ?? receiptVersion(
      effect,
      effect.destinationPath,
      "before",
      { exists: false },
      input.at,
    ),
    resource.version,
  );
  return requireResource(input.database, resource.resourceId);
}

async function applyMove(
  input: EffectServiceInput,
  effect: Extract<VerifiedFilesystemResourceEffect, { operation: "moved" }>,
): Promise<ResourceRef> {
  let source = readResourceByLocator(
    input.database,
    filesystemLocator(effect.sourcePath),
  );
  if (!source) {
    const destination = readResourceByLocator(
      input.database,
      filesystemLocator(effect.destinationPath),
    );
    if (
      destination
      && destination.formerLocators?.some((locator) => (
        locator.kind === "filesystem" && locator.path === effect.sourcePath
      ))
    ) {
      source = destination;
    }
  }
  if (!source) {
    source = await ensureResourceAtPath({
      ...input,
      effect,
      path: effect.sourcePath,
      state: effect.before ?? { exists: true, kind: effect.kind },
      origin: "agent_discovered",
    });
  }
  const beforeVersion = source.version;
  const destinationObservation = await observeForEffect(
    effect,
    effect.destinationPath,
    effect.after ?? { exists: true, kind: effect.kind },
    input.at,
    source.kind,
  );
  const relocated = input.database.transaction(() => relocateFilesystemResource(
    input.database,
    {
      resourceId: source!.resourceId,
      sourcePath: effect.sourcePath,
      destinationPath: effect.destinationPath,
      afterVersion: destinationObservation.version,
      runId: input.runId,
      at: input.at,
    },
  ));
  recordEffect(
    input,
    relocated,
    effect,
    "moved",
    beforeVersion,
    relocated.version,
  );
  return requireResource(input.database, relocated.resourceId);
}

async function ensureResourceAtPath(input: EffectServiceInput & {
  effect: VerifiedFilesystemResourceEffect;
  path: string;
  state: VerifiedFilesystemResourceEffectState;
  origin: ResourceOrigin;
}): Promise<ResourceRef> {
  const existing = readResourceByLocator(
    input.database,
    filesystemLocator(input.path),
  );
  const observation = await observeForEffect(
    input.effect,
    input.path,
    input.state,
    input.at,
    existing?.kind,
  );
  const admission: ObservedResourceAdmission = {
    admissionId: "effect:" + input.effect.effectId + ":" + input.path,
    kind: existing?.kind ?? observation.kind,
    origin: existing?.origin ?? input.origin,
    locator: observation.locator,
    displayName: existing?.displayName ?? observation.displayName,
    ...(existing?.metadataStatus === "enriched"
      ? {
          description: existing.description,
          aliases: existing.aliases,
        }
      : {}),
    role: "reference",
    version: observation.version,
    ...(existing?.mediaType ?? observation.mediaType
      ? { mediaType: existing?.mediaType ?? observation.mediaType }
      : {}),
  };
  return input.database.transaction(() => upsertResource(input.database, {
    admission,
    runId: input.runId,
    at: input.at,
  }).resource);
}

async function observeForEffect(
  effect: VerifiedFilesystemResourceEffect,
  path: string,
  state: VerifiedFilesystemResourceEffectState,
  at: string,
  existingKind?: ResourceKind,
): Promise<ObservedResource> {
  const observed = await observeResource(filesystemLocator(path), {
    at,
    ...(existingKind ? { kind: existingKind } : {}),
    directoryMode: "shallow",
  });
  if (
    observed.version.exists === state.exists
    && (!state.kind || !state.exists || observed.version.kind === state.kind)
    && (!state.sha256 || observed.version.sha256 === state.sha256)
  ) {
    return observed;
  }
  return {
    locator: filesystemLocator(path),
    kind: existingKind ?? effect.kind,
    displayName: basename(path) || path,
    version: receiptVersion(effect, path, "state", state, at),
    mutationEligible: true,
    warnings: [
      "A later verified effect changed this path before resource finalization.",
    ],
  };
}

async function reconcileFinalState(
  input: EffectServiceInput,
  affected: {
    resource: ResourceRef;
    expectedState: VerifiedFilesystemResourceEffectState;
  },
): Promise<ResourceRef> {
  const current = requireResource(input.database, affected.resource.resourceId);
  if (current.locator.kind !== "filesystem") return current;
  const observed = await observeResource(current.locator, {
    at: input.at,
    kind: current.kind,
    directoryMode: "shallow",
  });
  assertExpectedFinalState(
    current.locator.path,
    affected.expectedState,
    observed.version,
    current.resourceId,
  );
  const type: ResourceEvent["type"] = affected.expectedState.exists
    ? current.availability === "deleted" || current.availability === "missing"
      ? "restored"
      : "observed"
    : "deleted";
  return input.database.transaction(() => {
    recordResourceObservation(input.database, {
      resourceId: current.resourceId,
      runId: input.runId,
      beforeVersion: current.version,
      afterVersion: observed.version,
      type,
      verification: {
        source: "verified_filesystem_resource_effect_reconciliation",
      },
      summary: affected.expectedState.exists
        ? "Reconciled the final verified state of " + current.displayName + "."
        : "Confirmed " + current.displayName + " remains deleted.",
      at: input.at,
      callId: "resource-effect-final:" + current.resourceId,
      workstreamId: input.workstreamId,
      requestId: input.requestId,
    });
    return requireResource(input.database, current.resourceId);
  });
}

async function verifyFinalFilesystemStates(
  effects: VerifiedFilesystemResourceEffect[],
  at: string,
): Promise<void> {
  const expectedByPath = new Map<string, {
    kind: "file" | "directory";
    state: VerifiedFilesystemResourceEffectState;
  }>();
  for (const effect of effects) {
    if (effect.operation === "moved") {
      expectedByPath.set(effect.sourcePath, {
        kind: effect.kind,
        state: { exists: false },
      });
      expectedByPath.set(effect.destinationPath, {
        kind: effect.kind,
        state: effect.after ?? { exists: true, kind: effect.kind },
      });
      continue;
    }
    if (effect.operation === "copied") {
      expectedByPath.set(effect.destinationPath, {
        kind: effect.kind,
        state: effect.after ?? { exists: true, kind: effect.kind },
      });
      continue;
    }
    expectedByPath.set(effect.path, {
      kind: effect.kind,
      state: effect.after ?? defaultAfterState(effect),
    });
  }
  for (const [path, expected] of expectedByPath) {
    const observed = await observeResource(filesystemLocator(path), {
      at,
      kind: expected.kind,
      directoryMode: "shallow",
    });
    assertExpectedFinalState(path, expected.state, observed.version);
  }
}

function assertExpectedFinalState(
  path: string,
  expected: VerifiedFilesystemResourceEffectState,
  actual: ResourceVersion,
  resourceId?: string,
): void {
  const kindMismatch = expected.exists
    && expected.kind !== undefined
    && actual.kind !== expected.kind;
  const hashMismatch = expected.exists
    && expected.sha256 !== undefined
    && actual.sha256 !== expected.sha256;
  if (
    actual.exists === expected.exists
    && !kindMismatch
    && !hashMismatch
  ) {
    return;
  }
  throw new ContextEngineServiceError({
    code: "RESOURCE_VERIFICATION_UNAVAILABLE",
    message: "Filesystem state changed after its verified mutation receipt.",
    details: {
      ...(resourceId ? { resourceId } : {}),
      path,
      expected,
      actual: {
        exists: actual.exists,
        kind: actual.kind,
        ...(actual.sha256 ? { sha256: actual.sha256 } : {}),
      },
    },
  });
}

function finalStateForEffect(
  effect: VerifiedFilesystemResourceEffect,
): VerifiedFilesystemResourceEffectState {
  if (effect.operation === "moved" || effect.operation === "copied") {
    return effect.after ?? { exists: true, kind: effect.kind };
  }
  return effect.after ?? defaultAfterState(effect);
}

function recordEffect(
  input: EffectServiceInput,
  resource: ResourceRef,
  effect: VerifiedFilesystemResourceEffect,
  type: ResourceEvent["type"],
  beforeVersion: ResourceVersion,
  afterVersion: ResourceVersion,
): void {
  input.database.transaction(() => {
    recordResourceObservation(input.database, {
      resourceId: resource.resourceId,
      runId: input.runId,
      beforeVersion,
      afterVersion,
      type,
      verification: {
        source: "deterministic_tool_verification",
        effect,
      },
      summary: effectSummary(effect, resource.displayName, type),
      at: input.at,
      step: effect.step,
      callId: effect.callId ?? effect.effectId,
      workstreamId: input.workstreamId,
      requestId: input.requestId,
    });
    recordResourceAccess(
      input.database,
      resource.resourceId,
      input.runId,
      "mutated",
      input.at,
    );
  });
}

function resourceEventType(
  operation: "created" | "modified" | "permissions_changed" | "deleted",
  existing: ResourceRef | undefined,
): ResourceEvent["type"] {
  if (operation === "deleted") return "deleted";
  if (
    existing?.availability === "deleted"
    || existing?.availability === "missing"
  ) {
    return "restored";
  }
  return operation === "created" ? "created" : "modified";
}

function defaultBeforeState(
  effect: Extract<
    VerifiedFilesystemResourceEffect,
    { operation: "created" | "modified" | "permissions_changed" | "deleted" }
  >,
): VerifiedFilesystemResourceEffectState {
  return effect.operation === "created"
    ? { exists: false }
    : { exists: true, kind: effect.kind };
}

function defaultAfterState(
  effect: Extract<
    VerifiedFilesystemResourceEffect,
    { operation: "created" | "modified" | "permissions_changed" | "deleted" }
  >,
): VerifiedFilesystemResourceEffectState {
  return effect.operation === "deleted"
    ? { exists: false }
    : { exists: true, kind: effect.kind };
}

function receiptVersion(
  effect: VerifiedFilesystemResourceEffect,
  path: string,
  phase: string,
  state: VerifiedFilesystemResourceEffectState,
  at: string,
): ResourceVersion {
  const kind = state.kind ?? effect.kind;
  return {
    key: state.sha256
      ? "file:sha256:" + state.sha256
      : [
          "verified-effect",
          effect.effectId,
          phase,
          path,
          state.exists ? "present" : "missing",
        ].join(":"),
    observedAt: at,
    exists: state.exists,
    kind: state.exists ? kind : "unversioned",
    ...(state.sha256 ? { sha256: state.sha256 } : {}),
  };
}

function filesystemLocator(path: string): { kind: "filesystem"; path: string } {
  return { kind: "filesystem", path };
}

function requireResource(database: ContextDatabase, resourceId: string): ResourceRef {
  const resource = readResource(database, resourceId);
  if (!resource) throw new Error("Resource disappeared during effect application: " + resourceId);
  return resource;
}

function effectSummary(
  effect: VerifiedFilesystemResourceEffect,
  displayName: string,
  type: ResourceEvent["type"],
): string {
  if (type === "restored") return "Restored " + displayName + ".";
  switch (effect.operation) {
    case "created":
      return "Created " + displayName + ".";
    case "modified":
      return "Modified " + displayName + ".";
    case "permissions_changed":
      return "Changed permissions for " + displayName + ".";
    case "deleted":
      return "Deleted " + displayName + ".";
    case "copied":
      return "Copied " + displayName + " from " + effect.sourcePath + ".";
    case "moved":
      return "Moved " + displayName + " from " + effect.sourcePath + ".";
  }
}

type EffectServiceInput = {
  database: ContextDatabase;
  runId: string;
  workstreamId: string;
  requestId: string;
  at: string;
};
