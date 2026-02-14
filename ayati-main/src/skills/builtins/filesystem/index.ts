import type { SkillDefinition } from "../../types.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { deleteTool } from "./delete.js";
import { listDirectoryTool } from "./list-directory.js";
import { createDirectoryTool } from "./create-directory.js";
import { moveTool } from "./move.js";
import { findFilesTool } from "./find-files.js";
import { searchInFilesTool } from "./search-in-files.js";

const FS_PROMPT_BLOCK = [
  "Filesystem Skill is available.",
  "Use filesystem tools for safe, structured file and directory operations.",
  "Prefer find_files and search_in_files for discovery tasks.",
  "Use list_directory only when folder listing is explicitly needed.",
  "Tools: read_file, write_file, edit_file, delete, list_directory, create_directory, move, find_files, search_in_files.",
  "read_file supports offset/limit for large files; output is capped at 100K characters.",
  "write_file can create parent directories with createDirs=true.",
  "edit_file performs find-and-replace; use replaceAll=true for global replacement.",
  "delete requires recursive=true to remove directories and may require confirmation.",
  "list_directory supports recursive and showHidden options; caps are guardrail-controlled.",
  "move handles cross-device moves automatically via copy+delete fallback.",
  "find_files and search_in_files support roots, depth limits, and result caps.",
].join("\n");

const filesystemSkill: SkillDefinition = {
  id: "filesystem",
  version: "1.0.0",
  description: "File and directory operations — read, write, edit, delete, list, create, move, and search.",
  promptBlock: FS_PROMPT_BLOCK,
  tools: [
    readFileTool,
    writeFileTool,
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
