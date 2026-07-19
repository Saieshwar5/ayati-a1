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

const FS_PROMPT_BLOCK = [
  "Filesystem tools are built in.",
  "Use them directly for safe, structured file and directory operations.",
  "Prefer creating scratch files, generated output, and ad-hoc work inside the active absolute resource root.",
  "Use absolute paths for every host filesystem path in tool calls.",
  "During workstream work, each call must stay inside one exact bound filesystem resource; use its absolute locator path.",
  "Relative paths are valid inside generated content such as imports and HTML links, but not for tool resource addressing.",
  "Prefer find_files and search_in_files for discovery tasks.",
  "Use list_directory only when folder listing is explicitly needed.",
  "Use inspect_paths before content reads when candidate files are unknown, numerous, large, or may include directories/binary files; it returns size, line count, type, and read recommendations.",
  "Tools: inspect_paths, read_files, write_files, patch_files, delete, list_directory, create_directory, move, find_files, search_in_files.",
  "Use read_files for known file content; a single file is files=[{path,...}], and multiple known files should be batched instead of read one by one.",
  "Per call limits: read_files accepts at most 4 files, write_files accepts at most 2 files, and patch_files accepts at most 2 files; split larger work into additional tool calls.",
  "read_files entries default to mode=auto and return compact profile/focused context cards instead of dumping broad file text.",
  "Use read_files mode=search with query for relevant blocks, mode=slice with startLine/lineCount for exact ranges, mode=profile for metadata/outline, and mode=full only when explicitly needed.",
  "write_files serializes a validated file batch with temp-file writes and renames; use it for new files, single-file writes, multi-file writes, and full-file rewrites.",
  "When write_files overwrites an existing file, pass files[].baseSha256 from a recent read_files full-read result; if the hash is missing or stale, re-read the file instead of using process execution for mutation.",
  "patch_files patches existing files with small stable targets, tolerant line matching, anchor inserts, and line-range replacements; use endLine=\"EOF\" for replace_lines through the current end of file instead of guessing the final line number.",
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
    inspectPathsTool,
    readFilesTool,
    writeFilesTool,
    patchFilesTool,
    deleteTool,
    listDirectoryTool,
    createDirectoryTool,
    moveTool,
    findFilesTool,
    searchInFilesTool,
  ],
};

export default filesystemSkill;
