import { basename, extname, resolve } from "node:path";
import type { LoopState } from "../types.js";

export type FilesystemResourceDisposition =
  | "created"
  | "existing"
  | "moved";

export interface FilesystemResourceContextEntry {
  disposition: FilesystemResourceDisposition;
  operation: string;
  sourcePath?: string;
}

export function filesystemResourceContextByPath(
  state: LoopState,
): Map<string, FilesystemResourceContextEntry> {
  const context = new Map<string, FilesystemResourceContextEntry>();
  for (const call of state.toolContext?.toolCalls ?? []) {
    const pathEvidence = (call.completionEvidence ?? []).filter(
      (evidence) => evidence.kind === "path_state",
    );
    const movedSource = pathEvidence.find((evidence) => (
      evidence.operation === "move" && !evidence.exists
    ));
    for (const evidence of pathEvidence) {
      const path = resolve(evidence.path);
      if (evidence.operation === "move") {
        if (evidence.exists) {
          context.set(path, {
            disposition: "moved",
            operation: "move",
            ...(movedSource ? { sourcePath: resolve(movedSource.path) } : {}),
          });
        }
        continue;
      }
      if (
        evidence.operation === "copy"
        || evidence.operation === "create"
        || (
          evidence.operation === "write"
          && evidence.writeStatus === "created"
        )
      ) {
        context.set(path, {
          disposition: "created",
          operation: evidence.operation,
        });
        continue;
      }
      if (
        evidence.operation === "patch"
        || evidence.operation === "permissions"
        || (
          evidence.operation === "write"
          && evidence.writeStatus !== "created"
        )
        || (
          call.tool === "create_directory"
          && evidence.operation === "inspect"
        )
      ) {
        context.set(path, {
          disposition: "existing",
          operation: evidence.operation,
        });
      }
    }
  }
  return context;
}

export function filesystemResourceAliases(
  path: string,
  displayName: string,
  existing: string[] = [],
  sourcePath?: string,
): string[] {
  const extension = extname(displayName);
  const stem = extension
    ? displayName.slice(0, -extension.length)
    : displayName;
  return unique([
    ...existing,
    displayName,
    basename(path),
    ...(stem !== displayName ? [stem] : []),
    ...(sourcePath ? [basename(sourcePath)] : []),
  ]);
}

export function filesystemResourceDescription(input: {
  path: string;
  displayName: string;
  kind: "file" | "directory";
  context?: FilesystemResourceContextEntry;
  existingDescription?: string;
  validated?: boolean;
}): string {
  if (input.context?.disposition === "moved") {
    const source = input.context.sourcePath
      ? ` from ${input.context.sourcePath}`
      : "";
    const prior = input.existingDescription
      ? ` ${input.existingDescription}`
      : "";
    return `Moved ${input.kind} ${input.displayName}${source}.${prior}`;
  }
  if (input.existingDescription) return input.existingDescription;
  if (input.context?.operation === "copy") {
    return `Agent-created ${input.kind} copy ${input.displayName}.`;
  }
  if (input.context?.disposition === "existing") {
    return `${input.validated ? "Validated" : "Known"} existing ${input.kind} ${input.displayName}.`;
  }
  return `${input.validated ? "Validated agent-created" : "Agent-created"} ${input.kind} ${input.displayName}.`;
}

function unique(values: string[]): string[] {
  return [...new Set(
    values.map((value) => value.trim()).filter((value) => value.length > 0),
  )];
}
