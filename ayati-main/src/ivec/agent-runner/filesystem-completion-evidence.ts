import { resolve } from "node:path";
import { requireAbsoluteFilesystemPath } from "../../shared/filesystem-paths.js";
import type {
  ActToolCallRecord,
  FilesystemCompletionEvidence,
  FilesystemReadMode,
  FilesystemReadCoverage,
} from "../types.js";

export function deriveFilesystemCompletionEvidence(
  call: ActToolCallRecord,
  step: number,
  verificationPassed: boolean,
): FilesystemCompletionEvidence[] {
  if (!verificationPassed
    || call.error
    || call.operationStatus === "failed"
    || call.result?.operationStatus === "failed") {
    return [];
  }

  const structured = asRecord(call.result?.structuredContent);
  if (!structured) return [];

  let evidence: FilesystemCompletionEvidence[];
  switch (call.tool) {
    case "read_files":
      evidence = readFileEvidence(call, step, structured);
      break;
    case "inspect_paths":
      evidence = inspectPathEvidence(call, step, structured);
      break;
    case "find_files":
      evidence = findFileEvidence(call, step, structured);
      break;
    case "list_directory":
      evidence = singlePresentPathEvidence(
        call,
        step,
        structured,
        "dirPath",
        "directory",
        "list",
        "observed",
      );
      break;
    case "write_files":
      evidence = fileMutationEvidence(call, step, structured, "write");
      break;
    case "patch_files":
      evidence = fileMutationEvidence(call, step, structured, "patch");
      break;
    case "create_directory":
      evidence = createDirectoryEvidence(call, step, structured);
      break;
    case "copy":
      evidence = copyEvidence(call, step, structured);
      break;
    case "move":
      evidence = moveEvidence(call, step, structured);
      break;
    case "set_permissions":
      evidence = permissionEvidence(call, step, structured);
      break;
    case "delete":
      evidence = deleteEvidence(call, step, structured);
      break;
    default:
      return [];
  }
  return attachMutationTransitions(evidence, call);
}

function readFileEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  const evidence: FilesystemCompletionEvidence[] = [];
  for (const value of recordArray(structured["results"])) {
    if (value["ok"] !== true) continue;
    const path = canonicalPath(value["filePath"] ?? value["requestedPath"]);
    if (!path) continue;
    const requestedPath = readString(value["requestedPath"]) ?? path;
    const reference = callReference(call, step);
    evidence.push({
      kind: "path_state",
      path,
      requestedPath,
      exists: true,
      actualKind: "file",
      change: "observed",
      operation: "read",
      tool: call.tool,
      ...reference,
    });
    evidence.push({
      kind: "file_read",
      path,
      requestedPath,
      coverage: readCoverage(value["coverage"]),
      contentAvailable: Object.prototype.hasOwnProperty.call(value, "content")
        && typeof value["content"] === "string",
      change: "observed",
      tool: "read_files",
      ...reference,
      ...(readMode(value["mode"]) ? { mode: readMode(value["mode"]) } : {}),
      ...(readBoolean(value["truncated"]) !== undefined
        ? { truncated: readBoolean(value["truncated"]) }
        : {}),
      ...(readBoolean(value["lineCountKnown"]) !== undefined
        ? { lineCountKnown: readBoolean(value["lineCountKnown"]) }
        : {}),
      ...(readNumber(value["startLine"]) !== undefined
        ? { startLine: readNumber(value["startLine"]) }
        : {}),
      ...(readNumber(value["endLine"]) !== undefined
        ? { endLine: readNumber(value["endLine"]) }
        : {}),
      ...(readString(value["query"]) ? { query: readString(value["query"]) } : {}),
      ...(readNumber(value["matchCount"]) !== undefined
        ? { matchCount: readNumber(value["matchCount"]) }
        : {}),
      ...(readNumber(value["sizeBytes"]) !== undefined
        ? { sizeBytes: readNumber(value["sizeBytes"]) }
        : {}),
      ...(readNumber(value["lineCount"]) !== undefined
        ? { lineCount: readNumber(value["lineCount"]) }
        : {}),
      ...(readString(value["sha256"]) ? { sha256: readString(value["sha256"]) } : {}),
    });
  }
  return evidence;
}

function inspectPathEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  return recordArray(structured["results"]).flatMap((entry) => {
    const path = canonicalPath(entry["path"] ?? entry["requestedPath"]);
    if (!path || typeof entry["exists"] !== "boolean") return [];
    const kind = filesystemKind(entry["kind"]);
    return [{
      kind: "path_state",
      path,
      ...(readString(entry["requestedPath"]) ? { requestedPath: readString(entry["requestedPath"]) } : {}),
      exists: entry["exists"],
      ...(kind ? { actualKind: kind } : {}),
      change: "observed",
      operation: "inspect",
      tool: call.tool,
      ...callReference(call, step),
    }];
  });
}

function findFileEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  const matches = recordArray(structured["matches"]);
  const pathEvidence = matches.flatMap((entry): FilesystemCompletionEvidence[] => {
    const path = canonicalPath(entry["absolutePath"]);
    if (!path) return [];
    return [{
      kind: "path_state",
      path,
      exists: true,
      actualKind: filesystemKind(entry["kind"]) ?? "file",
      change: "observed",
      operation: "find",
      tool: call.tool,
      ...callReference(call, step),
    }];
  });
  const searchEvidence = fileSearchEvidence(call, step, structured, matches);
  return [
    ...(searchEvidence ? [searchEvidence] : []),
    ...pathEvidence,
  ];
}

function fileSearchEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
  matches: Record<string, unknown>[],
): Extract<FilesystemCompletionEvidence, { kind: "file_search" }> | undefined {
  const query = readString(structured["query"]);
  const roots = canonicalPathArray(structured["roots"]);
  const matchCount = readNonNegativeInteger(structured["matchCount"]);
  const maxDepth = readPositiveInteger(structured["maxDepth"]);
  const includeHidden = readBoolean(structured["includeHidden"]);
  const capped = readBoolean(structured["capped"]);
  const errorCount = readNonNegativeInteger(structured["errorCount"]);
  const reportedErrors = structured["errors"];
  const depthLimitedDirectoryCount = readNonNegativeInteger(
    structured["depthLimitedDirectoryCount"],
  );
  if (
    !query
    || !roots
    || matchCount === undefined
    || matchCount !== matches.length
    || maxDepth === undefined
    || includeHidden === undefined
    || capped === undefined
    || errorCount === undefined
    || !Array.isArray(reportedErrors)
    || (errorCount === 0 && reportedErrors.length !== 0)
    || depthLimitedDirectoryCount === undefined
  ) {
    return undefined;
  }
  const complete = !capped
    && errorCount === 0
    && depthLimitedDirectoryCount === 0;
  if (readBoolean(structured["traversalComplete"]) !== complete) {
    return undefined;
  }
  return {
    kind: "file_search",
    query,
    roots,
    matchCount,
    maxDepth,
    includeHidden,
    capped,
    errorCount,
    depthLimitedDirectoryCount,
    complete,
    change: "observed",
    tool: "find_files",
    ...callReference(call, step),
  };
}

function fileMutationEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
  operation: "write" | "patch",
): FilesystemCompletionEvidence[] {
  return recordArray(structured["files"]).flatMap((entry) => {
    if (operation === "write" && entry["status"] === "failed") return [];
    if (operation === "patch" && entry["status"] !== "patched") return [];
    const path = canonicalPath(
      operation === "write"
        ? entry["path"] ?? entry["filePath"] ?? entry["requestedPath"]
        : entry["filePath"] ?? entry["requestedPath"],
    );
    if (!path) return [];
    return [{
      kind: "path_state",
      path,
      ...(readString(entry["requestedPath"]) ? { requestedPath: readString(entry["requestedPath"]) } : {}),
      exists: true,
      actualKind: "file",
      change: operation === "write" && entry["status"] === "unchanged"
        ? "observed"
        : "mutated",
      operation,
      ...(operation === "write" && writeStatus(entry["status"])
        ? { writeStatus: writeStatus(entry["status"]) }
        : {}),
      tool: call.tool,
      ...callReference(call, step),
    }];
  });
}

function writeStatus(
  value: unknown,
): "created" | "replaced" | "unchanged" | undefined {
  return value === "created" || value === "replaced" || value === "unchanged"
    ? value
    : undefined;
}

function singlePresentPathEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
  pathField: string,
  actualKind: "file" | "directory",
  operation: "list" | "create",
  change: "observed" | "mutated",
): FilesystemCompletionEvidence[] {
  const path = canonicalPath(structured[pathField]);
  if (!path) return [];
  return [{
    kind: "path_state",
    path,
    ...(readString(structured["requestedPath"])
      ? { requestedPath: readString(structured["requestedPath"]) }
      : {}),
    exists: true,
    actualKind,
    change,
    operation,
    tool: call.tool,
    ...callReference(call, step),
  }];
}

function createDirectoryEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  const path = canonicalPath(structured["dirPath"]);
  const status = structured["status"];
  if (!path || (status !== "created" && status !== "already_exists")) return [];
  return [{
    kind: "path_state",
    path,
    ...(readString(structured["requestedPath"])
      ? { requestedPath: readString(structured["requestedPath"]) }
      : {}),
    exists: true,
    actualKind: "directory",
    change: status === "created" ? "mutated" : "observed",
    operation: status === "created" ? "create" : "inspect",
    tool: call.tool,
    ...callReference(call, step),
  }];
}

function copyEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  if (structured["status"] !== "copied") return [];
  const source = canonicalPath(
    structured["source"] ?? structured["requestedSource"],
  );
  const destination = canonicalPath(
    structured["destination"] ?? structured["requestedDestination"],
  );
  const actualKind = filesystemKind(structured["kind"]);
  const reference = callReference(call, step);
  return [
    ...(source ? [{
      kind: "path_state" as const,
      path: source,
      exists: true,
      ...(actualKind ? { actualKind } : {}),
      change: "observed" as const,
      operation: "inspect" as const,
      tool: call.tool,
      ...reference,
    }] : []),
    ...(destination ? [{
      kind: "path_state" as const,
      path: destination,
      exists: true,
      ...(actualKind ? { actualKind } : {}),
      change: "mutated" as const,
      operation: "copy" as const,
      tool: call.tool,
      ...reference,
    }] : []),
  ];
}

function moveEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  if (structured["moved"] !== true) return [];
  const source = canonicalPath(structured["source"] ?? structured["requestedSource"]);
  const destination = canonicalPath(structured["destination"] ?? structured["requestedDestination"]);
  const actualKind = filesystemKind(structured["kind"]);
  const reference = callReference(call, step);
  return [
    ...(source ? [{
      kind: "path_state" as const,
      path: source,
      exists: false,
      ...(actualKind ? { actualKind } : {}),
      change: "mutated" as const,
      operation: "move" as const,
      tool: call.tool,
      ...reference,
    }] : []),
    ...(destination ? [{
      kind: "path_state" as const,
      path: destination,
      exists: true,
      ...(actualKind ? { actualKind } : {}),
      change: "mutated" as const,
      operation: "move" as const,
      tool: call.tool,
      ...reference,
    }] : []),
  ];
}

function permissionEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  return recordArray(structured["files"]).flatMap((entry) => {
    if (entry["status"] !== "changed" && entry["status"] !== "unchanged") {
      return [];
    }
    const path = canonicalPath(entry["path"]);
    if (!path) return [];
    return [{
      kind: "path_state",
      path,
      exists: true,
      actualKind: "file",
      change: entry["status"] === "changed" ? "mutated" : "observed",
      operation: "permissions",
      tool: call.tool,
      ...callReference(call, step),
    }];
  });
}

function deleteEvidence(
  call: ActToolCallRecord,
  step: number,
  structured: Record<string, unknown>,
): FilesystemCompletionEvidence[] {
  const path = canonicalPath(structured["targetPath"] ?? structured["requestedPath"]);
  if (!path) return [];
  const status = structured["status"];
  if (status !== "deleted" && status !== "already_absent") return [];
  const actualKind = filesystemKind(structured["kind"]);
  return [{
    kind: "path_state",
    path,
    ...(readString(structured["requestedPath"])
      ? { requestedPath: readString(structured["requestedPath"]) }
      : {}),
    exists: false,
    ...(actualKind ? { actualKind } : {}),
    change: status === "deleted" ? "mutated" : "observed",
    operation: status === "deleted" ? "delete" : "inspect",
    tool: call.tool,
    ...callReference(call, step),
  }];
}

function callReference(
  call: ActToolCallRecord,
  step: number,
): { step: number; callId?: string } {
  return {
    step,
    ...(call.callId ? { callId: call.callId } : {}),
  };
}

function attachMutationTransitions(
  evidence: FilesystemCompletionEvidence[],
  call: ActToolCallRecord,
): FilesystemCompletionEvidence[] {
  const verification = asRecord(call.meta?.["filesystemMutationVerification"]);
  if (verification?.["verified"] !== true) return evidence;
  const targets = recordArray(verification["targets"]);
  if (targets.length === 0) return evidence;
  const byPath = new Map(targets.flatMap((target) => {
    const path = canonicalPath(target["path"]);
    return path ? [[path, target] as const] : [];
  }));
  return evidence.map((item): FilesystemCompletionEvidence => {
    if (item.kind !== "path_state") return item;
    const transition = byPath.get(resolve(item.path));
    if (!transition) return item;
    const beforeKind = targetStateKind(transition["before"]);
    const afterKind = targetStateKind(transition["after"]);
    const beforeSha256 = readString(transition["beforeSha256"]);
    const afterSha256 = readString(transition["afterSha256"]);
    return {
      ...item,
      ...(beforeKind ? { beforeKind } : {}),
      ...(afterKind ? { afterKind } : {}),
      ...(beforeSha256 ? { beforeSha256 } : {}),
      ...(afterSha256 ? { afterSha256 } : {}),
    };
  });
}

function targetStateKind(
  value: unknown,
): "missing" | "file" | "directory" | "symlink" | "other" | undefined {
  return value === "missing"
    || value === "file"
    || value === "directory"
    || value === "symlink"
    || value === "other"
    ? value
    : undefined;
}

function readCoverage(value: unknown): FilesystemReadCoverage {
  return value === "complete"
    || value === "partial"
    || value === "search_matches"
    || value === "profile"
    || value === "sampled"
    ? value
    : "partial";
}

function readMode(value: unknown): FilesystemReadMode | undefined {
  return value === "auto"
    || value === "profile"
    || value === "search"
    || value === "slice"
    || value === "full"
    ? value
    : undefined;
}

function filesystemKind(
  value: unknown,
): "file" | "directory" | "symlink" | undefined {
  return value === "file" || value === "directory" || value === "symlink"
    ? value
    : undefined;
}

function canonicalPath(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  const required = requireAbsoluteFilesystemPath(raw);
  return required.ok ? resolve(required.absolutePath) : undefined;
}

function canonicalPathArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const paths = value.map(canonicalPath);
  if (paths.some((path) => path === undefined)) return undefined;
  return [...new Set(paths as string[])];
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => asRecord(item) !== undefined)
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    ? value
    : undefined;
}
