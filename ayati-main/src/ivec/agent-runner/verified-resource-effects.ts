import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type {
  VerifiedFilesystemResourceEffect,
  VerifiedFilesystemResourceEffectState,
} from "ayati-context-engine";
import type {
  FilesystemCompletionEvidence,
  LoopState,
  RunToolCallContext,
} from "../types.js";

type PathEvidence = Extract<
  FilesystemCompletionEvidence,
  { kind: "path_state" }
>;

/**
 * Project independently verified filesystem mutations into durable resource
 * effects. This deliberately does not inspect validation-mode checks: an
 * executor-confirmed physical change remains true even when the larger task
 * later ends incomplete or fails semantic validation.
 */
export function buildVerifiedResourceEffects(
  state: LoopState,
): VerifiedFilesystemResourceEffect[] {
  const effects: VerifiedFilesystemResourceEffect[] = [];
  const seen = new Set<string>();
  for (const call of state.toolContext?.toolCalls ?? []) {
    if (
      call.stepKind === "transient_context"
      || call.status !== "success"
      || call.verificationPassed !== true
    ) {
      continue;
    }
    for (const effect of effectsForCall(state, call)) {
      if (seen.has(effect.effectId)) continue;
      seen.add(effect.effectId);
      effects.push(effect);
    }
  }
  return effects;
}

function effectsForCall(
  state: LoopState,
  call: RunToolCallContext,
): VerifiedFilesystemResourceEffect[] {
  const evidence = (call.completionEvidence ?? []).filter(
    (item): item is PathEvidence => item.kind === "path_state",
  );
  if (evidence.length === 0) return [];

  if (call.tool === "copy") {
    return pairEffect(state.runId, call, evidence, "copied");
  }
  if (call.tool === "move") {
    return pairEffect(state.runId, call, evidence, "moved");
  }

  return evidence.flatMap((item): VerifiedFilesystemResourceEffect[] => {
    if (item.change !== "mutated") return [];
    const kind = resourceKind(item.actualKind)
      ?? existingResourceKind(state, item.path);
    if (!kind) return [];
    const operation = unaryOperation(item);
    if (!operation) return [];
    const path = resolve(item.path);
    return [{
      effectId: effectId(
        state.runId,
        call,
        operation,
        [path],
      ),
      operation,
      path,
      kind,
      step: call.step,
      ...(call.callId ? { callId: call.callId } : {}),
      tool: call.tool,
      ...(call.evidenceRef ? { evidenceRef: call.evidenceRef } : {}),
      before: transitionState(item, "before")
        ?? beforeState(operation, kind),
      after: transitionState(item, "after")
        ?? afterState(operation, kind),
    }];
  });
}

function pairEffect(
  runId: string,
  call: RunToolCallContext,
  evidence: PathEvidence[],
  operation: "copied" | "moved",
): VerifiedFilesystemResourceEffect[] {
  const expectedOperation = operation === "copied" ? "copy" : "move";
  const destination = evidence.find((item) => (
    item.operation === expectedOperation
    && item.exists
    && item.change === "mutated"
  ));
  const source = evidence.find((item) => (
    operation === "copied"
      ? item.operation === "inspect" && item.exists
      : item.operation === "move" && !item.exists && item.change === "mutated"
  ));
  const kind = resourceKind(destination?.actualKind ?? source?.actualKind);
  if (!source || !destination || !kind) return [];
  const sourcePath = resolve(source.path);
  const destinationPath = resolve(destination.path);
  return [{
    effectId: effectId(
      runId,
      call,
      operation,
      [sourcePath, destinationPath],
    ),
    operation,
    sourcePath,
    destinationPath,
    kind,
    step: call.step,
    ...(call.callId ? { callId: call.callId } : {}),
    tool: call.tool,
    ...(call.evidenceRef ? { evidenceRef: call.evidenceRef } : {}),
    before: transitionState(source, "before") ?? {
      exists: true,
      kind,
    },
    after: transitionState(destination, "after") ?? {
      exists: true,
      kind,
    },
  }];
}

function unaryOperation(
  evidence: PathEvidence,
): Extract<
  VerifiedFilesystemResourceEffect["operation"],
  "created" | "modified" | "permissions_changed" | "deleted"
> | undefined {
  if (evidence.operation === "write") {
    return evidence.writeStatus === "created" ? "created" : "modified";
  }
  if (evidence.operation === "create") return "created";
  if (evidence.operation === "patch") return "modified";
  if (evidence.operation === "permissions") return "permissions_changed";
  if (evidence.operation === "delete") return "deleted";
  return undefined;
}

function beforeState(
  operation: "created" | "modified" | "permissions_changed" | "deleted",
  kind: "file" | "directory",
): VerifiedFilesystemResourceEffectState {
  return operation === "created"
    ? { exists: false }
    : { exists: true, kind };
}

function afterState(
  operation: "created" | "modified" | "permissions_changed" | "deleted",
  kind: "file" | "directory",
): VerifiedFilesystemResourceEffectState {
  return operation === "deleted"
    ? { exists: false }
    : { exists: true, kind };
}

function existingResourceKind(
  state: LoopState,
  path: string,
): "file" | "directory" | undefined {
  const canonical = resolve(path);
  for (const binding of state.harnessContext.contextEngine?.workstream?.resources ?? []) {
    const resource = binding.resource;
    if (
      resource.locator.kind === "filesystem"
      && resolve(resource.locator.path) === canonical
      && (resource.kind === "file" || resource.kind === "directory")
    ) {
      return resource.kind;
    }
  }
  return undefined;
}

function resourceKind(
  kind: PathEvidence["actualKind"],
): "file" | "directory" | undefined {
  return kind === "file" || kind === "directory" ? kind : undefined;
}

function transitionState(
  evidence: PathEvidence,
  phase: "before" | "after",
): VerifiedFilesystemResourceEffectState | undefined {
  const stateKind = phase === "before"
    ? evidence.beforeKind
    : evidence.afterKind;
  const sha256 = phase === "before"
    ? evidence.beforeSha256
    : evidence.afterSha256;
  if (!stateKind) return undefined;
  if (stateKind === "missing") return { exists: false };
  const kind = stateKind === "file" || stateKind === "directory"
    ? stateKind
    : undefined;
  return {
    exists: true,
    ...(kind ? { kind } : {}),
    ...(sha256 ? { sha256 } : {}),
  };
}

function effectId(
  runId: string,
  call: RunToolCallContext,
  operation: VerifiedFilesystemResourceEffect["operation"],
  paths: string[],
): string {
  return "FRE-" + createHash("sha256")
    .update([
      runId,
      String(call.step),
      call.callId ?? "",
      call.tool,
      operation,
      ...paths,
    ].join("\u0000"))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
}
