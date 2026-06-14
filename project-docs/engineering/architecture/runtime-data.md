# Runtime Data

Runtime output lives under `ayati-main/data/`.

Known runtime data categories:

- Session data.
- Focus cards and attention shelf indexes.
- Personal memory.
- Episodic memory metadata and vector indexes.
- Document storage and document vectors.
- Managed file library.
- Runtime provider configuration.
- Generated run artifacts.
- System-event queues.
- Plugin state.
- SQLite tool database.

Do not commit runtime data unless a specific fixture is intentionally created for tests.
