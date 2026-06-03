# Runtime Data

Runtime output lives under `ayati-main/data/`.

Known runtime data categories:

- Session data.
- Personal memory.
- Episodic memory metadata and vector indexes.
- Document storage and document vectors.
- Managed file library.
- Runtime provider configuration.
- External skill catalog/cache data.
- Generated run artifacts.
- System-event queues.
- Plugin state.
- Telegram state.
- SQLite tool database.

Do not commit runtime data unless a specific fixture is intentionally created for tests.
