# Backend Services

Major backend services and stores:

- `IVecEngine`: coordinates user messages, system events, context building, provider calls, tool execution, replies, notifications, and session rotation.
- `MemoryManager`: active session persistence and session close handling.
- `PersonalMemoryStore`: canonical user memory storage for personalization.
- `PersonalMemorySnapshotCache`: prompt-ready personal memory snapshots.
- `MemoryConsolidator`: post-session personal memory evolution.
- `EpisodicMemoryIndexer`: indexes closed sessions when embeddings are available.
- `EpisodicMemoryRetriever`: semantic recall for past sessions.
- `DocumentStore`: managed document storage.
- `DocumentContextBackend`: document reads and retrieval.
- `PreparedAttachmentService`: prepares files for document/dataset workflows.
- `FileLibrary`: managed file upload/download/metadata store.
- `PulseScheduler`: reminder and scheduled-work execution.
- `SystemIngressService`: normalizes and queues internal/external system events for daemon processing.
- `SystemEventWorker`: processes queued system events through the engine.
- `PluginRegistry`: starts and stops plugins.
- `ExternalSkillRegistry` and external skill broker: discover and mount runtime skills.

Daemon-specific responsibilities:

- Keep memory and runtime state available across client sessions.
- Accept inputs from multiple future communication channels.
- Use the tool executor as the computer-access layer.
- Process background events even when no CLI is actively connected.
- Keep client transports thin and focused on input/output.
