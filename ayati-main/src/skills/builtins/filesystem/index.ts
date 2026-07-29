import type { SkillDefinition } from "../../types.js";
import { inspectPathsTool } from "./inspect-paths.js";
import { readFilesTool } from "./read-files.js";
import { writeFilesTool } from "./write-files.js";
import { patchFilesTool } from "./patch-files.js";
import { deleteTool } from "./delete.js";
import { listDirectoryTool } from "./list-directory.js";
import { createDirectoryTool } from "./create-directory.js";
import { moveTool } from "./move.js";
import { findFilesTool } from "./find-files.js";
import { searchInFilesTool } from "./search-in-files.js";
import { copyTool } from "./copy.js";
import { setPermissionsTool } from "./set-permissions.js";

const filesystemSkill: SkillDefinition = {
  id: "filesystem",
  version: "1.0.0",
  description: "File and directory operations — read, write, edit, copy, move, delete, set permissions, list, create, and search.",
  tools: [
    inspectPathsTool,
    readFilesTool,
    writeFilesTool,
    patchFilesTool,
    deleteTool,
    listDirectoryTool,
    createDirectoryTool,
    copyTool,
    moveTool,
    setPermissionsTool,
    findFilesTool,
    searchInFilesTool,
  ],
};

export default filesystemSkill;
