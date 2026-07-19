# Security Notes

Never commit secrets. Keep API keys in local `.env` files.

Important env vars include provider keys and optional HTTP API token.

High-risk runtime capabilities:

- Process execution tools.
- Filesystem tools.
- Python tool.
- SQLite database tools.
- Plugin webhooks.
- Upload handling.
- Git Context workstream/resource lifecycle mutation.

Resources and context repositories are separate security boundaries:

- authorize mutation against exact bound resource locators and access modes;
- resolve symlinks before enforcing file or directory containment;
- never let model input choose arbitrary Git metadata paths;
- keep uploaded bytes in immutable managed resource storage;
- never commit deliverables, secrets, raw transcripts, or private attachments
  into workstream context Git;
- keep runtime-owned workstream/request updates and commits behind the typed Git
  Context service.

Agents should not weaken validation or policy files casually. Review these files before changing tool or event permissions:

- `ayati-main/context/system-event-policy.json`
- `ayati-main/context/memory-policy.json`

Do not add real credentials, private tokens, or personal data to `project-docs/`.
