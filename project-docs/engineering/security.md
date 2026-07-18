# Security Notes

Never commit secrets. Keep API keys in local `.env` files.

Important env vars include provider keys and optional HTTP API token.

High-risk runtime capabilities:

- Shell tools.
- Filesystem tools.
- Python tool.
- SQLite database tools.
- Plugin webhooks.
- Upload handling.
- Git Context task and repository mutation.

Task repositories are a security boundary as well as a context mechanism:

- authorize mutation against the canonical selected task working directory;
- resolve symlinks before enforcing the root;
- never let model input choose arbitrary Git metadata paths;
- keep `.ayati/inbox/` ignored and review attachments before adoption;
- do not commit secrets, large generated files, raw tool transcripts, or
  private attachments by default;
- keep runtime-owned task/request updates and commits behind the typed Git
  Context service.

Agents should not weaken validation or policy files casually. Review these files before changing tool or event permissions:

- `ayati-main/context/system-event-policy.json`
- `ayati-main/context/memory-policy.json`

Do not add real credentials, private tokens, or personal data to `project-docs/`.
