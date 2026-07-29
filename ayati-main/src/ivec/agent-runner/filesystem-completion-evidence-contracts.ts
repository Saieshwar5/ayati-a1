export type FilesystemReadCoverage =
  | "complete"
  | "partial"
  | "search_matches"
  | "profile"
  | "sampled";

export type FilesystemReadMode =
  | "auto"
  | "profile"
  | "search"
  | "slice"
  | "full";

export type FilesystemCompletionEvidence =
  | {
      kind: "file_read";
      path: string;
      requestedPath: string;
      coverage: FilesystemReadCoverage;
      contentAvailable: boolean;
      change: "observed";
      tool: "read_files";
      step: number;
      callId?: string;
      mode?: FilesystemReadMode;
      truncated?: boolean;
      lineCount?: number;
      lineCountKnown?: boolean;
      startLine?: number;
      endLine?: number;
      query?: string;
      matchCount?: number;
      sizeBytes?: number;
      sha256?: string;
    }
  | {
      kind: "file_search";
      query: string;
      roots: string[];
      matchCount: number;
      maxDepth: number;
      includeHidden: boolean;
      capped: boolean;
      errorCount: number;
      depthLimitedDirectoryCount: number;
      complete: boolean;
      change: "observed";
      tool: "find_files";
      step: number;
      callId?: string;
    }
  | {
      kind: "path_state";
      path: string;
      requestedPath?: string;
      exists: boolean;
      actualKind?: "file" | "directory" | "symlink";
      change: "observed" | "mutated";
      operation:
        | "inspect"
        | "find"
        | "read"
        | "list"
        | "write"
        | "patch"
        | "create"
        | "copy"
        | "move"
        | "permissions"
        | "delete";
      beforeKind?: "missing" | "file" | "directory" | "symlink" | "other";
      afterKind?: "missing" | "file" | "directory" | "symlink" | "other";
      beforeSha256?: string;
      afterSha256?: string;
      writeStatus?: "created" | "replaced" | "unchanged";
      tool: string;
      step: number;
      callId?: string;
    };
