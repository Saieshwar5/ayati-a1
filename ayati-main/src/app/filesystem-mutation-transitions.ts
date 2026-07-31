import { resolve } from "node:path";
import {
  sameFilesystemTargetState,
} from "../shared/filesystem-target-state.js";
import {
  fingerprintPath,
  type PathFingerprint,
} from "../skills/builtins/filesystem/copy-path-operation.js";
import type { ToolResult } from "../skills/types.js";
import type {
  PathState,
  PreparedFilesystemMutationVerification,
  TargetSpec,
} from "./filesystem-mutation-verifier.js";
import {
  deleteCleanupPathProblems,
  reportedDirectoryProblems,
} from "./filesystem-result-path-verification.js";

export async function filesystemMutationTransitionProblems(
  prepared: PreparedFilesystemMutationVerification,
  afterTargets: Map<string, PathState>,
  result: ToolResult,
): Promise<string[]> {
  switch (prepared.toolName) {
    case "write_files":
      return writeProblems(prepared, afterTargets, result);
    case "patch_files":
      return patchProblems(prepared, afterTargets, result);
    case "create_directory":
      return await createProblems(prepared, afterTargets, result);
    case "move":
      return await moveProblems(prepared, afterTargets, result);
    case "copy":
      return await copyProblems(prepared, afterTargets, result);
    case "delete":
      return await deleteProblems(prepared, afterTargets, result);
    case "set_permissions":
      return permissionProblems(prepared, afterTargets, result);
    case "process_run":
      return processProblems(prepared, afterTargets, result);
    default:
      return [];
  }
}

function writeProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): string[] {
  const statuses = fileStatuses(result);
  return prepared.targets.flatMap((target) => {
    const reported = statuses.get(target.path);
    const before = beforeState(prepared, target.path);
    const current = afterState(after, target.path);
    if (!reported) {
      return omittedProblems(result, before, current, "write_files", target.path);
    }
    if (reported.status === "failed") {
      return unchangedProblems(before, current, "Failed write", target.path);
    }
    if (current.kind !== "file") {
      return [`Expected a file at ${target.path}; observed ${current.kind}.`];
    }
    const problems: string[] = [];
    if (target.expectedSha256 !== current.sha256) {
      problems.push(`Written file hash does not match requested content: ${target.path}.`);
    }
    if (reported.sha256 !== current.sha256) {
      problems.push(`write_files reported an incorrect final hash: ${target.path}.`);
    }
    if (reported.status === "created" && before.kind !== "missing") {
      problems.push(`write_files incorrectly reported created: ${target.path}.`);
    }
    if (
      reported.status === "replaced"
      && (before.kind !== "file" || before.sha256 === current.sha256)
    ) {
      problems.push(`write_files incorrectly reported replaced: ${target.path}.`);
    }
    if (
      reported.status === "unchanged"
      && !sameFilesystemTargetState(before, current)
    ) {
      problems.push(`write_files incorrectly reported unchanged: ${target.path}.`);
    }
    return problems;
  });
}

function patchProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): string[] {
  const statuses = fileStatuses(result);
  return prepared.targets.flatMap((target) => {
    const reported = statuses.get(target.path);
    const before = beforeState(prepared, target.path);
    const current = afterState(after, target.path);
    if (!reported) {
      return omittedProblems(result, before, current, "patch_files", target.path);
    }
    if (reported.status === "failed") {
      return unchangedProblems(before, current, "Failed patch", target.path);
    }
    if (before.kind !== "file" || current.kind !== "file") {
      return [`Patch target is not a regular file: ${target.path}.`];
    }
    const problems: string[] = [];
    if (!reported.sha256 || reported.sha256 !== current.sha256) {
      problems.push(`Patched file hash does not match the tool result: ${target.path}.`);
    }
    if (before.sha256 === current.sha256) {
      problems.push(`patch_files reported patched without a content change: ${target.path}.`);
    }
    if (before.mode !== current.mode) {
      problems.push(`patch_files changed file mode: ${target.path}.`);
    }
    if (before.linkCount !== current.linkCount) {
      problems.push(`patch_files changed hard-link count: ${target.path}.`);
    }
    return problems;
  });
}

async function createProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): Promise<string[]> {
  const target = prepared.targets[0];
  if (!target) return ["create_directory verification is missing its target."];
  const before = beforeState(prepared, target.path);
  const current = afterState(after, target.path);
  const structured = structuredResult(result);
  const status = structured?.["status"];
  if (status === "created") {
    return [
      ...(before.kind === "missing" && current.kind === "directory"
        ? []
        : [`create_directory reported created without the expected missing-to-directory transition: ${target.path}.`]),
      ...await reportedDirectoryProblems({
        structured,
        field: "createdPaths",
        target: target.path,
        allowTarget: true,
        label: "create_directory",
      }),
    ];
  }
  if (status === "already_exists") {
    return before.kind === "directory" && sameFilesystemTargetState(before, current)
      ? []
      : [`create_directory reported already_exists for changed state: ${target.path}.`];
  }
  if (status === "partial" || status === "failed") {
    return [
      ...unchangedProblems(
        before,
        current,
        "Failed directory creation",
        target.path,
      ),
      ...await reportedDirectoryProblems({
        structured,
        field: "createdPaths",
        target: target.path,
        allowTarget: false,
        label: "create_directory",
      }),
    ];
  }
  return result.ok
    ? ["Successful create_directory result omitted a supported status."]
    : unchangedProblems(before, current, "Failed directory creation", target.path);
}

async function moveProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): Promise<string[]> {
  const pair = sourceDestination(prepared, "move");
  if (!pair) return ["Move verification is missing source or destination."];
  const beforeSource = beforeState(prepared, pair.source.path);
  const beforeDestination = beforeState(prepared, pair.destination.path);
  const afterSource = afterState(after, pair.source.path);
  const afterDestination = afterState(after, pair.destination.path);
  const structured = structuredResult(result);
  const status = structured?.["status"];
  if (status === "failed" || (!status && !result.ok)) {
    return [
      ...unchangedProblems(
        beforeSource,
        afterSource,
        "Failed move source",
        pair.source.path,
      ),
      ...unchangedProblems(
        beforeDestination,
        afterDestination,
        "Failed move destination",
        pair.destination.path,
      ),
    ];
  }
  if (status === "copied_but_source_retained") {
    return [
      ...unchangedProblems(
        beforeSource,
        afterSource,
        "Retained move source",
        pair.source.path,
      ),
      ...await copiedDestinationProblems(
        beforeSource,
        afterDestination,
        structured,
        pair.destination.path,
        "MOVE",
      ),
      ...await reportedDirectoryProblems({
        structured,
        field: "createdParentPaths",
        target: pair.destination.path,
        allowTarget: false,
        label: "move",
      }),
    ];
  }
  if (status !== "moved" && status !== "moved_unverified") {
    return result.ok ? ["Successful move result omitted a supported status."] : [];
  }
  const problems = afterSource.kind === "missing"
    ? []
    : [`Moved source still exists: ${pair.source.path}.`];
  const strategy = structured?.["strategy"];
  if (strategy === "rename") {
    problems.push(...renamedDestinationProblems(
      beforeSource,
      afterDestination,
      pair.destination.path,
    ));
  } else {
    problems.push(...await copiedDestinationProblems(
      beforeSource,
      afterDestination,
      structured,
      pair.destination.path,
      "MOVE",
    ));
  }
  problems.push(...await reportedDirectoryProblems({
    structured,
    field: "createdParentPaths",
    target: pair.destination.path,
    allowTarget: false,
    label: "move",
  }));
  return problems;
}

async function copyProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): Promise<string[]> {
  const pair = sourceDestination(prepared, "copy");
  if (!pair) return ["Copy verification is missing source or destination."];
  const beforeSource = beforeState(prepared, pair.source.path);
  const beforeDestination = beforeState(prepared, pair.destination.path);
  const afterSource = afterState(after, pair.source.path);
  const afterDestination = afterState(after, pair.destination.path);
  const structured = structuredResult(result);
  const status = structured?.["status"];
  const sourceProblems = unchangedProblems(
    beforeSource,
    afterSource,
    "Copy source",
    pair.source.path,
  );
  if (status === "failed" || (!status && !result.ok)) {
    return [
      ...sourceProblems,
      ...unchangedProblems(
        beforeDestination,
        afterDestination,
        "Failed copy destination",
        pair.destination.path,
      ),
    ];
  }
  if (status !== "copied" && status !== "copied_unverified") {
    return result.ok
      ? ["Successful copy result omitted a supported status."]
      : sourceProblems;
  }
  return [
    ...sourceProblems,
    ...await copiedDestinationProblems(
      beforeSource,
      afterDestination,
      structured,
      pair.destination.path,
      "COPY",
    ),
    ...await reportedDirectoryProblems({
      structured,
      field: "createdParentPaths",
      target: pair.destination.path,
      allowTarget: false,
      label: "copy",
    }),
  ];
}

async function deleteProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): Promise<string[]> {
  const target = prepared.targets[0];
  if (!target) return ["Delete verification is missing its target."];
  const before = beforeState(prepared, target.path);
  const current = afterState(after, target.path);
  const structured = structuredResult(result);
  const status = structured?.["status"];
  if (status === "deleted" || status === "cleanup_pending") {
    const problems = before.kind !== "missing" && current.kind === "missing"
      ? []
      : [`Delete did not produce the reported absent target: ${target.path}.`];
    return status === "cleanup_pending"
      ? [
          ...problems,
          ...await deleteCleanupPathProblems(structured, target.path),
        ]
      : problems;
  }
  if (status === "already_absent") {
    return before.kind === "missing" && current.kind === "missing"
      ? []
      : [`Delete incorrectly reported already_absent: ${target.path}.`];
  }
  if (status === "failed" || !result.ok) {
    return unchangedProblems(before, current, "Failed delete", target.path);
  }
  return ["Successful delete result omitted a supported status."];
}

function permissionProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): string[] {
  const statuses = fileStatuses(result);
  return prepared.targets.flatMap((target) => {
    const before = beforeState(prepared, target.path);
    const current = afterState(after, target.path);
    const reported = statuses.get(target.path);
    if (!reported) {
      return omittedProblems(
        result,
        before,
        current,
        "set_permissions",
        target.path,
      );
    }
    if (reported.status === "failed") {
      return unchangedProblems(
        before,
        current,
        "Failed permission change",
        target.path,
      );
    }
    if (before.kind !== "file" || current.kind !== "file") {
      return [`Permission target is not a regular file: ${target.path}.`];
    }
    const problems: string[] = [];
    if (before.sha256 !== current.sha256) {
      problems.push(`set_permissions changed file content: ${target.path}.`);
    }
    if (
      before.device !== current.device
      || before.inode !== current.inode
    ) {
      problems.push(`set_permissions changed file identity: ${target.path}.`);
    }
    if (target.requestedMode !== current.mode) {
      problems.push(`set_permissions did not apply the requested mode: ${target.path}.`);
    }
    if (reported.status === "unchanged" && before.mode !== current.mode) {
      problems.push(`set_permissions incorrectly reported unchanged: ${target.path}.`);
    }
    return problems;
  });
}

function processProblems(
  prepared: PreparedFilesystemMutationVerification,
  after: Map<string, PathState>,
  result: ToolResult,
): string[] {
  if (prepared.targets.length === 0) {
    return ["process_run verification is missing its declared targets."];
  }
  return prepared.targets.flatMap((target) => {
    const before = beforeState(prepared, target.path);
    const current = afterState(after, target.path);
    if (!result.ok) {
      return unchangedProblems(
        before,
        current,
        "Failed process",
        target.path,
      );
    }
    if (current.kind === "missing") {
      return [`Successful process target is missing: ${target.path}.`];
    }
    if (target.requestedKind && current.kind !== target.requestedKind) {
      return [
        `Successful process target has kind ${current.kind}, expected ${target.requestedKind}: ${target.path}.`,
      ];
    }
    return [];
  });
}

async function copiedDestinationProblems(
  source: PathState,
  destination: PathState,
  structured: Record<string, unknown> | undefined,
  path: string,
  prefix: "COPY" | "MOVE",
): Promise<string[]> {
  if (source.kind === "missing" || source.kind === "other") {
    return [`${prefix} source kind cannot be copied: ${path}.`];
  }
  if (destination.kind !== source.kind) {
    return [`${prefix} destination kind does not match its source: ${path}.`];
  }
  if (source.kind === "file" && destination.kind === "file") {
    return source.sha256 === destination.sha256 && source.mode === destination.mode
      ? []
      : [`${prefix} destination file does not match its source: ${path}.`];
  }
  if (source.kind === "symlink" && destination.kind === "symlink") {
    return source.linkTarget === destination.linkTarget
      ? []
      : [`${prefix} destination symbolic link does not match its source: ${path}.`];
  }
  const expected = resultFingerprint(structured);
  if (!expected) {
    return [`${prefix} directory result omitted its verified fingerprint: ${path}.`];
  }
  try {
    const actual = await fingerprintPath(path, prefix);
    return sameFingerprint(expected, actual)
      ? []
      : [`${prefix} destination directory fingerprint is incorrect: ${path}.`];
  } catch {
    return [`${prefix} destination directory could not be fingerprinted: ${path}.`];
  }
}

function renamedDestinationProblems(
  source: PathState,
  destination: PathState,
  path: string,
): string[] {
  if (source.kind !== destination.kind || source.kind === "missing") {
    return [`Moved destination kind does not match its source: ${path}.`];
  }
  if (source.kind === "file" && destination.kind === "file") {
    return source.sha256 === destination.sha256 && source.mode === destination.mode
      ? []
      : [`Moved file content or mode changed: ${path}.`];
  }
  if (source.kind === "symlink" && destination.kind === "symlink") {
    return source.linkTarget === destination.linkTarget
      ? []
      : [`Moved symbolic link target changed: ${path}.`];
  }
  if (source.kind === "directory" && destination.kind === "directory") {
    return source.device === destination.device && source.inode === destination.inode
      ? []
      : [`Atomic directory move did not preserve identity: ${path}.`];
  }
  return [];
}

function fileStatuses(
  result: ToolResult,
): Map<string, { status: string; sha256?: string }> {
  const statuses = new Map<string, { status: string; sha256?: string }>();
  const structured = structuredResult(result);
  if (!structured || !Array.isArray(structured["files"])) return statuses;
  for (const entry of structured["files"]) {
    if (!isRecord(entry) || typeof entry["status"] !== "string") continue;
    const candidate = typeof entry["path"] === "string"
      ? entry["path"]
      : entry["filePath"];
    if (typeof candidate !== "string") continue;
    statuses.set(resolve(candidate), {
      status: entry["status"],
      ...(typeof entry["sha256"] === "string" ? { sha256: entry["sha256"] } : {}),
    });
  }
  return statuses;
}

function sourceDestination(
  prepared: PreparedFilesystemMutationVerification,
  kind: "move" | "copy",
): { source: TargetSpec; destination: TargetSpec } | undefined {
  const sourceRole = kind === "move" ? "move_source" : "copy_source";
  const destinationRole = kind === "move"
    ? "move_destination"
    : "copy_destination";
  const source = prepared.targets.find((target) => target.role === sourceRole);
  const destination = prepared.targets.find(
    (target) => target.role === destinationRole,
  );
  return source && destination ? { source, destination } : undefined;
}

function beforeState(
  prepared: PreparedFilesystemMutationVerification,
  path: string,
): PathState {
  return prepared.beforeTargets.get(path) ?? { kind: "missing" };
}

function afterState(
  after: Map<string, PathState>,
  path: string,
): PathState {
  return after.get(path) ?? { kind: "missing" };
}

function unchangedProblems(
  before: PathState,
  after: PathState,
  label: string,
  path: string,
): string[] {
  return sameFilesystemTargetState(before, after)
    ? []
    : [`${label} changed target state: ${path}.`];
}

function omittedProblems(
  result: ToolResult,
  before: PathState,
  after: PathState,
  tool: string,
  path: string,
): string[] {
  if (result.ok) return [`Successful ${tool} result omitted target ${path}.`];
  return unchangedProblems(before, after, `Failed ${tool}`, path);
}

function structuredResult(
  result: ToolResult,
): Record<string, unknown> | undefined {
  const structuredContent = result.v2?.structuredContent;
  return isRecord(structuredContent) ? structuredContent : undefined;
}

function resultFingerprint(
  structured: Record<string, unknown> | undefined,
): PathFingerprint | undefined {
  return structured
    && (
      structured["kind"] === "file"
      || structured["kind"] === "directory"
      || structured["kind"] === "symlink"
    )
    && typeof structured["contentSha256"] === "string"
    && typeof structured["entryCount"] === "number"
    && typeof structured["totalBytes"] === "number"
    ? {
        kind: structured["kind"],
        contentSha256: structured["contentSha256"],
        entryCount: structured["entryCount"],
        totalBytes: structured["totalBytes"],
      }
    : undefined;
}

function sameFingerprint(
  left: PathFingerprint,
  right: PathFingerprint,
): boolean {
  return left.kind === right.kind
    && left.contentSha256 === right.contentSha256
    && left.entryCount === right.entryCount
    && left.totalBytes === right.totalBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
