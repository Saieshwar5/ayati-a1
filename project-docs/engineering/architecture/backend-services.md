# Backend Services

Major backend services and stores:

- `IVecEngine`: coordinates user messages, system events, context building, provider calls, tool execution, replies, and notifications.
- `GitMemoryRuntime`: daily git context runtime for global conversation,
  pending-turn ownership, automatic same-task binding, turn-aware task routing,
  run identity, task branches, assistant responses, evidence, and run commits.
- `PersonalMemoryStore`: canonical user memory storage for personalization.
- `PersonalMemorySnapshotCache`: prompt-ready personal memory snapshots.
- `EpisodicMemoryIndexer`: indexes episodic records when embeddings are available.
- `EpisodicMemoryRetriever`: semantic recall for past sessions.
- `ToolCatalog`: hidden catalog of available built-in/runtime tools, groups, aliases, and deterministic follow-up metadata.
- `ToolWorkingSetManager`: mounts a bounded run-scoped set of visible executable tool schemas for each decision.
- `DocumentStore`: prepared-document compatibility storage.
- `DocumentContextBackend`: document reads and retrieval for prepared text attachments.
- `PreparedAttachmentService`: compatibility layer for document/dataset workflows.
- `FileLibrary`: primary managed file upload/download/metadata store.
- `DirectoryLibrary`: primary managed directory manifest/search store.
- `PulseScheduler`: reminder and scheduled-work execution.
- `SystemIngressService`: normalizes and queues internal/external system events for daemon processing.
- `SystemEventWorker`: processes queued system events through the engine.
- `PluginRegistry`: starts and stops plugins.
- `SkillActivationManager`: optional support for mounting skill-provided tools into the executor.

Daemon-specific responsibilities:

- Keep git context and runtime state available across client sessions.
- Keep task lifecycle mutations deterministic: the agent may express routing
  intent, but runtime owns run allocation, task state updates, finalization, and
  commits.
- Accept inputs from multiple future communication channels.
- Use the tool executor as the computer-access layer.
- Process background events even when no CLI is actively connected.
- Keep client transports thin and focused on input/output.
