export interface ReadFileInput {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteFileInput {
  path: string;
  content: string;
  createDirs?: boolean;
}

export interface EditFileInput {
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
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
}
