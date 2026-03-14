# Workspace Preference Plan

## Goal

Make the agent prefer creating and working inside `work_space/` by default, without forbidding it from using other directories when the user explicitly asks or the task clearly requires it.

## Desired Behavior

- Relative file and directory paths should default to `work_space/`.
- The agent should treat `work_space/` as its primary working area.
- Absolute paths and non-`work_space/` paths should still be allowed.
- The model should avoid scattering files across the repo unless there is a clear reason.

## Simple Implementation Plan

1. Add a shared workspace path helper.
   - Create a small utility that resolves relative paths against `projectRoot/work_space`.
   - Keep absolute paths unchanged.

2. Update filesystem tools to use the helper.
   - Apply it to `read_file`, `write_file`, `edit_file`, `create_directory`, `delete`, `move`, `list_directory`, `find_files`, and `search_in_files`.
   - When a path is relative, the tool should operate inside `work_space/`.
   - When a path is absolute, the tool should honor it.

3. Change search and listing defaults.
   - If `list_directory` is called with a relative path, list under `work_space/`.
   - If `find_files` or `search_in_files` is called without explicit roots, search from `work_space/`.

4. Adjust shell defaults without hard restrictions.
   - Default shell `cwd` to `work_space/`.
   - If the model passes a different `cwd`, allow it.
   - This keeps the default behavior clean while preserving flexibility.

5. Update prompt guidance.
   - Tell the agent to prefer `work_space/` for creating files, scratch work, generated outputs, and temporary project artifacts.
   - Also tell it that other locations are allowed when the user asks for them or the task naturally targets another path.

6. Add focused tests.
   - Relative writes land in `work_space/`.
   - Relative directory creation happens in `work_space/`.
   - Search defaults use `work_space/`.
   - Shell defaults to `work_space/`.
   - Absolute and external paths still work when explicitly provided.

## Likely Files To Change

- `src/app/main.ts`
- `src/skills/builtins/filesystem/*.ts`
- `src/skills/builtins/shell/index.ts`
- `src/skills/builtins/filesystem/index.ts`
- `context/controller/direct.md`
- `tests/skills/filesystem/*.test.ts`
- `tests/skills/shell.test.ts`

## Notes

This approach keeps the behavior simple:

- `work_space/` becomes the default.
- Nothing is artificially blocked.
- The agent becomes cleaner and more predictable without losing the ability to work elsewhere.
