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
