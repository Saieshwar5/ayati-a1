import type { SkillDefinition } from "../../types.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { writeFilesTool } from "./write-files.js";
import { editFileTool } from "./edit-file.js";
import { deleteTool } from "./delete.js";
import { listDirectoryTool } from "./list-directory.js";
import { createDirectoryTool } from "./create-directory.js";
import { moveTool } from "./move.js";
import { findFilesTool } from "./find-files.js";
import { searchInFilesTool } from "./search-in-files.js";

const FS_PROMPT_BLOCK = [
  "Filesystem tools are built in.",
  "Use them directly for safe, structured file and directory operations.",
  "Prefer creating scratch files, generated output, and ad-hoc work inside the configured workspace root by default.",
  "Treat relative paths as workspace-relative unless the user clearly targets another location.",
  "Do not prefix relative paths with workspace/ or work_space/; the resolver already applies the workspace root.",
  "Absolute reads and explicit non-workspace paths are allowed when the task calls for them.",
  "For write/create/edit/delete/move outside the workspace, set allowExternalPath=true only when the user explicitly requested that external path.",
  "Prefer find_files and search_in_files for discovery tasks.",
  "Use list_directory only when folder listing is explicitly needed.",
  "Tools: read_file, write_file, write_files, edit_file, delete, list_directory, create_directory, move, find_files, search_in_files.",
  "read_file defaults to mode=auto and returns a compact profile/focused context card instead of dumping full file text.",
  "Use read_file mode=search with query for relevant blocks, mode=slice with startLine/lineCount for exact ranges, mode=profile for metadata/outline, and mode=full only when explicitly needed.",
  "write_file can create parent directories with createDirs=true.",
  "write_files serializes a validated multi-file batch with temp-file writes and renames; prefer it over separate writes for generated files that belong together.",
  "edit_file performs find-and-replace; use replaceAll=true for global replacement.",
  "delete requires recursive=true to remove directories and may require confirmation.",
  "list_directory returns grouped counts plus bounded entries; use find_files/search_in_files to narrow large trees.",
  "move handles cross-device moves automatically via copy+delete fallback.",
  "find_files and search_in_files support roots, depth limits, and result caps; search_in_files returns structured line-context matches.",
].join("\n");

const filesystemSkill: SkillDefinition = {
  id: "filesystem",
  version: "1.0.0",
  description: "File and directory operations — read, write, edit, delete, list, create, move, and search.",
  promptBlock: FS_PROMPT_BLOCK,
  tools: [
    readFileTool,
    writeFileTool,
    writeFilesTool,
    editFileTool,
    deleteTool,
    listDirectoryTool,
    createDirectoryTool,
    moveTool,
    findFilesTool,
    searchInFilesTool,
  ],
};

export default filesystemSkill;
