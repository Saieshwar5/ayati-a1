export interface ReadFileInput {
  path: string;
  mode?: "auto" | "profile" | "search" | "slice" | "full";
  query?: string;
  startLine?: number;
  lineCount?: number;
  contextLines?: number;
  maxBlocks?: number;
}

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

export interface WriteFileInput {
  path: string;
  content: string;
  createDirs?: boolean;
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export interface WriteFilesInputFile {
  path: string;
  content: string;
}

export interface WriteFilesInput {
  files: WriteFilesInputFile[];
  createDirs?: boolean;
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export interface EditFileInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export type EditFilesMode = "replace" | "insert_before" | "insert_after" | "replace_range";

export interface EditFilesInputEdit {
  path: string;
  mode?: EditFilesMode;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  anchor?: string;
  content?: string;
  startLine?: number;
  endLine?: number;
}

export interface EditFilesInput {
  edits: EditFilesInputEdit[];
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export type PatchFilesPatchKind = "replace_text" | "replace_all_text" | "insert_before" | "insert_after" | "replace_lines";

export interface PatchFilesPatch {
  kind: PatchFilesPatchKind;
  find?: string;
  replace?: string;
  anchor?: string;
  content?: string;
  startLine?: number;
  endLine?: number;
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

export interface DeleteInput {
  path: string;
  recursive?: boolean;
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export interface ListDirectoryInput {
  path: string;
  recursive?: boolean;
  showHidden?: boolean;
}

export interface CreateDirectoryInput {
  path: string;
  recursive?: boolean;
  allowExternalPath?: boolean;
  confirmationToken?: string;
}

export interface MoveInput {
  source: string;
  destination: string;
  overwrite?: boolean;
  allowExternalPath?: boolean;
  confirmationToken?: string;
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
