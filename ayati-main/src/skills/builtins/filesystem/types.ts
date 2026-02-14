export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
  createDirs?: boolean;
  confirmationToken?: string;
}

export interface EditFileInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
  confirmationToken?: string;
}

export interface DeleteInput {
  path: string;
  recursive?: boolean;
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
  confirmationToken?: string;
}

export interface MoveInput {
  source: string;
  destination: string;
  overwrite?: boolean;
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
}
