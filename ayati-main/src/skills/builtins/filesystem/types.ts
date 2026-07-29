export interface ReadFileInput {
  path: string;
  mode?: "auto" | "profile" | "search" | "slice" | "full";
  query?: string;
  startLine?: number;
  lineCount?: number;
  contextLines?: number;
  maxBlocks?: number;
}

export type ReadFileCoverage =
  | "complete"
  | "partial"
  | "search_matches"
  | "profile"
  | "sampled";

export interface ReadFilesInputFile extends ReadFileInput {}

export interface ReadFilesInput {
  files: ReadFilesInputFile[];
  maxPerFileChars?: number;
  maxTotalChars?: number;
  allowMissing?: boolean;
}

export interface InspectPathsInput {
  paths: string[];
  includeLineCount?: boolean;
  includeHash?: boolean;
  includeDirectoryCounts?: boolean;
}

export interface WriteFilesInputFile {
  path: string;
  content: string;
}

export interface WriteFilesInput {
  files: WriteFilesInputFile[];
  createParents?: boolean;
}

export type WriteFileStatus = "created" | "replaced" | "unchanged" | "failed";

export interface WriteFileResult {
  path: string;
  status: WriteFileStatus;
  sizeBytes: number;
  sha256: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface WriteFilesResult {
  filesRequested: number;
  filesChanged: number;
  filesUnchanged: number;
  filesFailed: number;
  bytesWritten: number;
  files: WriteFileResult[];
}

export type PatchFilesPatchKind = "replace_text" | "replace_all_text" | "insert_before" | "insert_after" | "replace_lines";

export interface PatchFilesPatch {
  kind: PatchFilesPatchKind;
  find?: string;
  replace?: string;
  anchor?: string;
  content?: string;
  startLine?: number;
  endLine?: number | "EOF";
}

export interface PatchFilesInputFile {
  path: string;
  patches: PatchFilesPatch[];
}

export interface PatchFilesInput {
  files: PatchFilesInputFile[];
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export type PatchFileStatus = "patched" | "failed";

export interface PatchFileResult {
  requestedPath: string;
  filePath: string;
  status: PatchFileStatus;
  patchesApplied: number;
  changesApplied: number;
  bytesWritten: number;
  sha256?: string;
  checks: Array<{
    patchIndex: number;
    kind: PatchFilesPatchKind;
    status: "passed";
    message: string;
    matchStrategy?: "exact" | "line_ending";
  }>;
  errorCode?: string;
  errorMessage?: string;
}

export interface PatchFilesResult {
  filesRequested: number;
  filesPatched: number;
  filesFailed: number;
  patchesApplied: number;
  changesApplied: number;
  totalBytes: number;
  files: PatchFileResult[];
}

export interface DeleteInput {
  path: string;
  recursive?: boolean;
}

export interface ListDirectoryInput {
  path: string;
  recursive?: boolean;
  showHidden?: boolean;
}

export interface CreateDirectoryInput {
  path: string;
  recursive?: boolean;
}

export interface MoveInput {
  source: string;
  destination: string;
  overwrite?: boolean;
  createParents?: boolean;
}

export type CreateDirectoryStatus =
  | "created"
  | "already_exists"
  | "partial"
  | "failed";

export interface CreateDirectoryResult {
  requestedPath: string;
  dirPath: string;
  recursive: boolean;
  status: CreateDirectoryStatus;
  createdPaths: string[];
  errorCode?: string;
  errorMessage?: string;
}

export type MoveStatus =
  | "moved"
  | "moved_unverified"
  | "copied_but_source_retained"
  | "failed";

export interface MoveResult {
  requestedSource: string;
  requestedDestination: string;
  source: string;
  destination: string;
  kind: "file" | "directory" | "symlink";
  strategy: "rename" | "copy_delete";
  status: MoveStatus;
  overwrite: boolean;
  moved: boolean;
  createdParentPaths: string[];
  contentSha256?: string;
  entryCount?: number;
  totalBytes?: number;
  errorCode?: string;
  errorMessage?: string;
}

export type DeleteStatus =
  | "deleted"
  | "already_absent"
  | "cleanup_pending"
  | "failed";

export interface DeleteResult {
  requestedPath: string;
  targetPath: string;
  kind?: "file" | "directory" | "symlink";
  status: DeleteStatus;
  deleted: boolean;
  cleanupPath?: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface CopyInput {
  source: string;
  destination: string;
  createParents?: boolean;
}

export interface CopyResult {
  requestedSource: string;
  requestedDestination: string;
  source: string;
  destination: string;
  kind: "file" | "directory" | "symlink";
  status: "copied" | "copied_unverified" | "failed";
  createdParentPaths: string[];
  contentSha256: string;
  entryCount: number;
  totalBytes: number;
  errorCode?: string;
  errorMessage?: string;
}

export interface SetPermissionsInputTarget {
  path: string;
  mode: string;
}

export interface SetPermissionsInput {
  files: SetPermissionsInputTarget[];
}

export type SetPermissionsStatus = "changed" | "unchanged" | "failed";

export interface SetPermissionsFileResult {
  path: string;
  requestedMode: string;
  mode: string;
  status: SetPermissionsStatus;
  sha256: string;
  errorCode?: string;
  errorMessage?: string;
}

export interface SetPermissionsResult {
  filesRequested: number;
  filesChanged: number;
  filesUnchanged: number;
  filesFailed: number;
  files: SetPermissionsFileResult[];
}

export interface FindFilesInput {
  query: string;
  roots?: string[];
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
}

export interface SearchInFilesInput {
  query: string;
  roots?: string[];
  maxDepth?: number;
  maxResults?: number;
  includeHidden?: boolean;
  caseSensitive?: boolean;
  contextLines?: number;
}
