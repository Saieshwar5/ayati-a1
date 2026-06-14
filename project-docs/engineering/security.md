# Security Notes

Never commit secrets. Keep API keys in local `.env` files.

Important env vars include provider keys, Telegram credentials, AgentMail credentials, Nylas credentials, and optional HTTP API token.

High-risk runtime capabilities:

- Shell tools.
- Filesystem tools.
- Python tool.
- SQLite database tools.
- Plugin webhooks.
- Upload handling.

Agents should not weaken validation or policy files casually. Review these files before changing tool or event permissions:

- `ayati-main/context/system-event-policy.json`
- `ayati-main/context/memory-policy.json`

Do not add real credentials, private tokens, or personal data to `project-docs/`.
