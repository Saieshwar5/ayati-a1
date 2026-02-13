import type { SkillDefinition } from "../../types.js";
import { readFileTool } from "./read-file.js";
import { writeFileTool } from "./write-file.js";
import { editFileTool } from "./edit-file.js";
import { deleteTool } from "./delete.js";
import { listDirectoryTool } from "./list-directory.js";
import { createDirectoryTool } from "./create-directory.js";
import { moveTool } from "./move.js";

const FS_PROMPT_BLOCK = [
  "Filesystem Skill is available.",
  "Use filesystem tools for file and directory operations instead of shell commands.",
  "Tools: read_file, write_file, edit_file, delete, list_directory, create_directory, move.",
  "read_file supports offset/limit for large files; output is capped at 100K characters.",
  "write_file can create parent directories with createDirs=true.",
  "edit_file performs find-and-replace; use replaceAll=true for global replacement.",
  "delete requires recursive=true to remove directories.",
  "list_directory supports recursive and showHidden options; capped at 1000 entries.",
  "move handles cross-device moves automatically via copy+delete fallback.",
].join("\n");

const filesystemSkill: SkillDefinition = {
  id: "filesystem",
  version: "1.0.0",
  description: "File and directory operations — read, write, edit, delete, list, create, move.",
  promptBlock: FS_PROMPT_BLOCK,
  tools: [
    readFileTool,
    writeFileTool,
    editFileTool,
    deleteTool,
    listDirectoryTool,
    createDirectoryTool,
    moveTool,
  ],
};

export default filesystemSkill;
