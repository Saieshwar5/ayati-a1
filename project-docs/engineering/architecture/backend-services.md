# Backend Services

Major backend services and stores:

- `IVecEngine`: coordinates user messages, context building, provider calls,
  tool execution, replies, and notifications.
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
- `ToolRegistry`: canonical exact-name registry for every executable tool;
  duplicate names and missing safety taxonomy fail startup.
- `CapabilityCatalog`: explicit small responsibilities with core/optional
  tools, allowed modes, and deterministic next-capability suggestions.
- `CapabilitySurfaceManager`: filters capabilities by mode and authority, then
  replaces the bounded run-scoped native tool surface.
- `FileLibrary`: unified managed-file upload, metadata, text extraction, table
  analysis, and run-association store.
- `DirectoryLibrary`: managed directory manifest, search, and run-association
  store.
- `SessionAttachmentService`: restores durable workstream file/directory
  resources into a run using their managed identities.

Daemon-specific responsibilities:

- Keep one Context Engine host and the default agent stream available across
  independent client connections.
- Keep durable lifecycle mutations deterministic: the agent may express
  routing intent, but Context Engine owns request allocation, resource journals,
  workstream reduction, finalization, and context commits.
- Accept inputs from multiple future communication channels.
- Use the tool executor as the computer-access layer.
- Keep client transports thin and focused on input/output.

See [Workstreams and Resources](workstreams-and-resources.md).
