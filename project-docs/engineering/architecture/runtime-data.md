# Runtime Data

Runtime output lives under `ayati-main/data/`.

Known runtime data categories:

- Session data.
- Focus cards and attention shelf indexes.
- Personal memory.
- Episodic memory metadata and vector indexes.
- Document storage and document vectors for prepared document compatibility.
- Managed attachment library: files under `data/files/`, directory manifests
  under `data/directories/`, and run attachment manifests under `data/runs/`.
- Runtime provider configuration.
- Generated run artifacts.
- System-event queues.
- Plugin state.
- SQLite tool database.

Do not commit runtime data unless a specific fixture is intentionally created for tests.
