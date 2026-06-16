# AYATI-0005 Unified Attachment Continuation

## Context

Attachment handling had two overlapping paths:

- prepared document/dataset records for old document tools
- managed file/directory records for newer attachment tools

That split made follow-up runs reliable for prepared documents and datasets, but
not for generic managed files or directories stored on focus cards.

## Changes

- Made active attachment memory generic across documents, datasets, files, and
  directories.
- Added `attachment_restore` as the preferred restore tool. The old
  `restore_attachment_context` tool remains as a compatibility alias.
- Extended attachment restoration to touch managed files and directories into
  the current run through `FileLibrary` and `DirectoryLibrary`.
- Updated runner state reduction so restored files and directories refresh
  `managedFiles` and `managedDirectories` before later tool calls in the same
  action.
- Stored file and directory capabilities on focus-card assets.
- Updated tool selection so active attachments participate in selection queries,
  and protected `focus_activate`, `attachment_restore`, and
  `restore_attachment_context` as continuation tools.
- Auto-activated the dataset skill when runs contain attachments.
- Added harness integration coverage for focus-card continuation of managed
  files and directories.

## Current Contract

The primary attachment workflow is:

```text
inbound attachment -> managed attachment record -> run state -> attachment_* tools
-> focus-card asset -> attachment_restore in a later run
```

Files are stored by `FileLibrary` under `data/files/<fileId>/`. Directories are
stored as manifests by `DirectoryLibrary` under `data/directories/<directoryId>/`.
Focus cards store restorable references, not full file contents.

Text and table work should prefer:

- `attachment_list`
- `attachment_inspect`
- `attachment_read`
- `attachment_query`
- `attachment_query_table`
- `directory_search`
- `attachment_restore`

Prepared document and dataset tools still exist for compatibility and specialized
retrieval paths.

## Limits

- Image attachments are registered and represented as image/OCR candidates, but
  full image question answering and OCR are not complete.
- Directory content search currently reads UTF-8 text files directly. Binary
  files inside directories should be registered as managed files before deeper
  extraction/querying.
- The old prepared document/dataset services still exist and should be phased
  behind the unified attachment tools instead of removed abruptly.

## Verification

```text
pnpm --filter ayati-main build
pnpm --filter ayati-main test -- tests/ivec/focus-continuation.test.ts tests/skills/activation-manager.test.ts tests/ivec/verification-gates.test.ts tests/documents/session-attachment-service.test.ts tests/skills/files.test.ts
```

Both commands passed. The focused test command currently runs the full backend
Vitest suite through the package script and reported 89 test files passed and
540 tests passed.
