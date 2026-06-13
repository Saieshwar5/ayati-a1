# Engineering Conventions

Language and runtime:

- TypeScript.
- ESM modules.
- Node.js 20+.
- pnpm workspaces.

Style:

- Use 2-space indentation.
- Use semicolons.
- Use double quotes.
- Prefer explicit public types.
- Keep modules focused and domain-based.
- Use kebab-case filenames, such as `session-manager.ts`.
- Keep tests as `*.test.ts` under matching domain folders in `tests/`.

Implementation guidance:

- Follow existing package boundaries.
- Reuse existing services, tool definitions, stores, and static prompt helpers.
- Avoid introducing new dependencies unless the existing codebase cannot reasonably solve the problem.
- Keep runtime state under `ayati-main/data/`, not source directories.
- Do not commit generated output, logs, `dist/`, `data/`, or secrets.
