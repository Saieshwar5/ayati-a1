# Backend Services

Major backend services and stores:

- `IVecEngine`: coordinates user messages, system events, context building, provider calls, tool execution, replies, and notifications.
- `ContextEngineHost`: acquires the exclusive writer lock, opens SQLite, runs
  startup recovery, exposes the service, and drains it during daemon shutdown.
- `ContextEngineRuntime`: typed daemon-side adapter for agent-stream, workstream,
  request, run, checkpoint, history, and context-projection operations.
- `SqliteContextEngineService`: in-process owner of agent-stream continuity, the
  context catalog, workstream/resource selection, request lifecycle, run journals,
  checkpoints, and Git finalization coordination.
- `PersonalMemoryStore`: canonical user memory storage for personalization.
- `PersonalMemorySnapshotCache`: rebuildable compact personal-memory source.
- `HotContextRuntime`: typed optional-context catalog and bounded disposable
  run mounts; loaded content is projected once into the next decision context.
- `EpisodicMemoryIndexer`: indexes episodic records when embeddings are available.
- `EpisodicMemoryRetriever`: semantic recall for past sessions.
- `ToolRegistry`: canonical exact-name registry for every executable tool;
  duplicate names and missing safety taxonomy fail startup.
- `CapabilityCatalog`: explicit small responsibilities with core/optional
  tools, allowed modes, and deterministic next-capability suggestions.
- `CapabilitySurfaceManager`: filters capabilities by mode and authority, then
  replaces the bounded run-scoped native tool surface.
- `DocumentStore`: prepared-document compatibility storage.
- `DocumentContextBackend`: document reads and retrieval for prepared text attachments.
- `PreparedAttachmentService`: compatibility layer for document/dataset workflows.
- `FileLibrary`: primary managed file upload/download/metadata store.
- `DirectoryLibrary`: primary managed directory manifest/search store.
- `PulseScheduler`: reminder and scheduled-work execution.
- `SystemIngressService`: normalizes and queues internal/external system events for daemon processing.
- `SystemEventWorker`: processes queued system events through the engine.
- `PluginRegistry`: starts and stops plugins.

Daemon-specific responsibilities:

- Keep one Context Engine host and the default agent stream available across
  independent client connections and system events.
- Keep durable lifecycle mutations deterministic: the agent may express
  routing intent, but Context Engine owns request allocation, resource journals,
  workstream reduction, finalization, and context commits.
- Accept inputs from multiple future communication channels.
- Use the tool executor as the computer-access layer.
- Process background events even when no CLI is actively connected.
- Keep client transports thin and focused on input/output.

See [Workstreams and Resources](workstreams-and-resources.md).
