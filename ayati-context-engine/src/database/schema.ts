import type { DatabaseSync } from "node:sqlite";
import schemaVersion from "./schema-version.json" with { type: "json" };

const SCHEMA_VERSION = schemaVersion.version;
const FOCUS_SCHEMA_VERSION = 10;
const BINDING_SCHEMA_VERSION = 11;

const RUN_WORKSTREAM_BINDING_IMMUTABLE_TRIGGER_SQL = [
  "CREATE TRIGGER runs_workstream_binding_immutable",
  "BEFORE UPDATE OF workstream_id, bound_request_id, workstream_bound_at ON runs",
  "WHEN OLD.workstream_id IS NOT NULL AND (NEW.workstream_id IS NOT OLD.workstream_id",
  "  OR NEW.bound_request_id IS NOT OLD.bound_request_id",
  "  OR NEW.workstream_bound_at IS NOT OLD.workstream_bound_at)",
  "AND NOT (NEW.workstream_id IS NULL AND NEW.bound_request_id IS NULL",
  "  AND NEW.workstream_bound_at IS NULL AND EXISTS (",
  "    SELECT 1 FROM workstreams w WHERE w.workstream_id = OLD.workstream_id",
  "      AND w.status = 'initializing' AND w.last_commit_sha IS NULL",
  "      AND w.created_by_run_id = OLD.run_id",
  "      AND NOT EXISTS (SELECT 1 FROM workstream_resources wr",
  "        WHERE wr.workstream_id = OLD.workstream_id)",
  "      AND NOT EXISTS (SELECT 1 FROM request_resources rr",
  "        WHERE rr.workstream_id = OLD.workstream_id)",
  "      AND NOT EXISTS (SELECT 1 FROM resource_events e",
  "        WHERE e.workstream_id = OLD.workstream_id)",
  "      AND NOT EXISTS (SELECT 1 FROM resource_mutation_leases l",
  "        WHERE l.workstream_id = OLD.workstream_id)",
  "      AND NOT EXISTS (SELECT 1 FROM workstream_progress p",
  "        WHERE p.workstream_id = OLD.workstream_id)",
  "      AND NOT EXISTS (SELECT 1 FROM workstream_finalizations f",
  "        WHERE f.workstream_id = OLD.workstream_id)",
  "      AND EXISTS (SELECT 1 FROM workstream_request_route_plans rp",
  "        WHERE rp.run_id = OLD.run_id AND rp.workstream_id = OLD.workstream_id",
  "          AND rp.bound_request_id = OLD.bound_request_id AND rp.phase = 'planned')",
  "  ))",
  "BEGIN SELECT RAISE(ABORT, 'run workstream binding is immutable'); END;",
].join("\n");

const BASELINE_TABLES = [
  "agent_streams",
  "context_checkpoints",
  "idempotency_requests",
  "message_resources",
  "message_response_metadata",
  "message_search",
  "messages",
  "request_resources",
  "resource_accesses",
  "resource_events",
  "resource_mutation_leases",
  "resource_mutation_locks",
  "resource_mutation_operations",
  "resource_search",
  "resources",
  "run_steps",
  "run_work_state",
  "runs",
  "schema_metadata",
  "unbound_run_finalizations",
  "workstream_accesses",
  "workstream_finalizations",
  "workstream_preferences",
  "workstream_progress",
  "workstream_repository_state",
  "workstream_request_route_plans",
  "workstream_request_search",
  "workstream_requests",
  "workstream_resources",
  "workstream_search",
  "workstreams",
] as const;

const RETIRED_OBSERVATION_TABLES = [
  "observation_resources",
  "reusable_observations",
] as const;

const RETIRED_RESOLUTION_TABLES = [
  "workstream_resolution_activities",
  "workstream_resolution_steps",
] as const;

const BASELINE_SQL = [
  "CREATE TABLE schema_metadata (",
  "  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),",
  "  version INTEGER NOT NULL,",
  "  created_at TEXT NOT NULL",
  ");",
  "",
  "CREATE TABLE idempotency_requests (",
  "  request_id TEXT PRIMARY KEY,",
  "  operation TEXT NOT NULL,",
  "  request_hash TEXT NOT NULL,",
  "  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'recovery_required')),",
  "  response_json TEXT NOT NULL,",
  "  created_at TEXT NOT NULL,",
  "  completed_at TEXT",
  ");",
  "",
  "CREATE TABLE agent_streams (",
  "  stream_id TEXT PRIMARY KEY,",
  "  agent_id TEXT NOT NULL,",
  "  scope_key TEXT NOT NULL,",
  "  last_message_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_message_sequence >= 0),",
  "  last_run_sequence INTEGER NOT NULL DEFAULT 0 CHECK (last_run_sequence >= 0),",
  "  active_checkpoint_id TEXT,",
  "  focused_workstream_id TEXT,",
  "  focused_request_id TEXT,",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  CHECK ((focused_workstream_id IS NULL AND focused_request_id IS NULL)",
  "    OR (focused_workstream_id IS NOT NULL AND focused_request_id IS NOT NULL)),",
  "  UNIQUE(agent_id, scope_key)",
  ");",
  "CREATE INDEX agent_streams_updated_at ON agent_streams(updated_at DESC);",
  "",
  "CREATE TABLE workstream_repository_state (",
  "  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),",
  "  repository_path TEXT NOT NULL UNIQUE,",
  "  branch TEXT NOT NULL CHECK (branch = 'main'),",
  "  head_sha TEXT NOT NULL,",
  "  repository_health TEXT NOT NULL CHECK (repository_health IN ('ready', 'dirty_external', 'recovery_required', 'unavailable')),",
  "  updated_at TEXT NOT NULL",
  ");",
  "",
  "CREATE TABLE workstreams (",
  "  workstream_id TEXT PRIMARY KEY CHECK (workstream_id GLOB 'W-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9]'),",
  "  directory_path TEXT NOT NULL UNIQUE,",
  "  title TEXT NOT NULL,",
  "  aliases_json TEXT NOT NULL DEFAULT '[]',",
  "  purpose TEXT NOT NULL,",
  "  initial_request_json TEXT,",
  "  lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('active', 'paused', 'archived')),",
  "  current_request_id TEXT,",
  "  current_snapshot TEXT NOT NULL,",
  "  current_focus TEXT NOT NULL,",
  "  blockers_json TEXT NOT NULL DEFAULT '[]',",
  "  last_run_id TEXT REFERENCES runs(run_id),",
  "  last_commit_sha TEXT,",
  "  last_activity_at TEXT NOT NULL,",
  "  status TEXT NOT NULL CHECK (status IN ('initializing', 'active', 'archived', 'recovery_required')),",
  "  created_by_run_id TEXT REFERENCES runs(run_id),",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  FOREIGN KEY (workstream_id, current_request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE INDEX workstreams_updated_at ON workstreams(updated_at DESC);",
  "CREATE INDEX workstreams_status ON workstreams(status, updated_at DESC);",
  "CREATE INDEX workstreams_activity ON workstreams(last_activity_at DESC);",
  "",
  "CREATE TABLE workstream_requests (",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id) ON DELETE CASCADE,",
  "  request_id TEXT NOT NULL CHECK (request_id GLOB 'R-[0-9][0-9][0-9][0-9]'),",
  "  relative_path TEXT NOT NULL,",
  "  title TEXT NOT NULL,",
  "  status TEXT NOT NULL CHECK (status IN ('queued', 'active', 'blocked', 'done', 'dropped')),",
  "  source TEXT NOT NULL CHECK (source IN ('user', 'agent_proposal', 'imported')),",
  "  request_text TEXT NOT NULL,",
  "  acceptance_json TEXT NOT NULL,",
  "  constraints_json TEXT NOT NULL,",
  "  contract_hash TEXT NOT NULL,",
  "  lifecycle_note TEXT NOT NULL,",
  "  outcome_summary TEXT NOT NULL,",
  "  created_by_run_id TEXT REFERENCES runs(run_id),",
  "  last_run_id TEXT REFERENCES runs(run_id),",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  started_at TEXT,",
  "  closed_at TEXT,",
  "  last_activity_at TEXT NOT NULL,",
  "  PRIMARY KEY(workstream_id, request_id),",
  "  UNIQUE(workstream_id, relative_path),",
  "  CHECK ((status IN ('done', 'dropped') AND closed_at IS NOT NULL)",
  "    OR (status NOT IN ('done', 'dropped') AND closed_at IS NULL))",
  ");",
  "CREATE UNIQUE INDEX workstream_requests_one_active ON workstream_requests(workstream_id)",
  "WHERE status = 'active';",
  "CREATE INDEX workstream_requests_status ON workstream_requests(status, last_activity_at DESC);",
  "CREATE VIRTUAL TABLE workstream_request_search USING fts5(",
  "  workstream_id UNINDEXED, request_id UNINDEXED, status, title, request_text, acceptance,",
  "  constraints, lifecycle_note, outcome_summary,",
  "  tokenize = 'unicode61 remove_diacritics 2'",
  ");",
  "",
  "CREATE TABLE workstream_progress (",
  "  run_id TEXT PRIMARY KEY,",
  "  workstream_id TEXT NOT NULL,",
  "  request_id TEXT NOT NULL,",
  "  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'incomplete', 'failed', 'blocked', 'needs_user_input')),",
  "  summary TEXT NOT NULL,",
  "  validation_summary TEXT NOT NULL,",
  "  next_action TEXT,",
  "  commit_sha TEXT NOT NULL,",
  "  finalized_at TEXT NOT NULL,",
  "  FOREIGN KEY (workstream_id, request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE INDEX workstream_progress_request ON workstream_progress(workstream_id, request_id, finalized_at DESC);",
  "CREATE INDEX workstream_progress_recent ON workstream_progress(finalized_at DESC);",
  "",
  "CREATE TABLE workstream_preferences (",
  "  workstream_id TEXT PRIMARY KEY REFERENCES workstreams(workstream_id) ON DELETE CASCADE,",
  "  starred INTEGER NOT NULL CHECK (starred IN (0, 1)),",
  "  starred_at TEXT,",
  "  updated_at TEXT NOT NULL,",
  "  CHECK ((starred = 1 AND starred_at IS NOT NULL) OR (starred = 0 AND starred_at IS NULL))",
  ");",
  "CREATE INDEX workstream_preferences_starred ON workstream_preferences(starred, starred_at DESC);",
  "",
  "CREATE TABLE messages (",
  "  message_id TEXT PRIMARY KEY,",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
  "  sequence INTEGER NOT NULL,",
  "  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system_event')),",
  "  content TEXT NOT NULL,",
  "  content_hash TEXT NOT NULL,",
  "  created_at TEXT NOT NULL,",
  "  UNIQUE(stream_id, sequence)",
  ");",
  "CREATE UNIQUE INDEX messages_one_ingress_per_run ON messages(run_id)",
  "WHERE role IN ('user', 'system_event');",
  "CREATE UNIQUE INDEX messages_one_assistant_per_run ON messages(run_id)",
  "WHERE role = 'assistant';",
  "CREATE INDEX messages_stream_created ON messages(stream_id, created_at, sequence);",
  "CREATE VIRTUAL TABLE message_search USING fts5(",
  "  message_id UNINDEXED, stream_id UNINDEXED, content,",
  "  tokenize = 'unicode61 remove_diacritics 2'",
  ");",
  "CREATE TRIGGER messages_immutable_update BEFORE UPDATE ON messages",
  "BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;",
  "CREATE TRIGGER messages_immutable_delete BEFORE DELETE ON messages",
  "BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;",
  "",
  "CREATE TABLE message_response_metadata (",
  "  message_id TEXT PRIMARY KEY REFERENCES messages(message_id) ON DELETE CASCADE,",
  "  response_kind TEXT NOT NULL CHECK (response_kind IN ('reply', 'feedback', 'notification')),",
  "  feedback_kind TEXT CHECK (feedback_kind IN ('approval', 'confirmation', 'clarification')),",
  "  CHECK (response_kind = 'feedback' OR feedback_kind IS NULL)",
  ");",
  "CREATE TRIGGER message_response_metadata_immutable_update BEFORE UPDATE ON message_response_metadata",
  "BEGIN SELECT RAISE(ABORT, 'message response metadata is immutable'); END;",
  "CREATE TRIGGER message_response_metadata_immutable_delete BEFORE DELETE ON message_response_metadata",
  "BEGIN SELECT RAISE(ABORT, 'message response metadata is immutable'); END;",
  "",
  "CREATE TABLE runs (",
  "  run_id TEXT PRIMARY KEY,",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  workstream_id TEXT REFERENCES workstreams(workstream_id),",
  "  bound_request_id TEXT,",
  "  workstream_bound_at TEXT,",
  "  run_sequence INTEGER NOT NULL,",
  "  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'incomplete', 'failed', 'blocked', 'needs_user_input', 'recovery_required')),",
  "  stop_reason TEXT CHECK (stop_reason IN ('completed', 'run_limit', 'context_limit', 'failed', 'blocked', 'needs_user_input', 'interrupted')),",
  "  trigger TEXT NOT NULL CHECK (trigger IN ('user', 'system_event')),",
  "  step_count INTEGER NOT NULL DEFAULT 0,",
  "  started_at TEXT NOT NULL,",
  "  completed_at TEXT,",
  "  CHECK ((workstream_id IS NULL AND bound_request_id IS NULL AND workstream_bound_at IS NULL)",
  "    OR (workstream_id IS NOT NULL AND bound_request_id IS NOT NULL AND workstream_bound_at IS NOT NULL)),",
  "  CHECK ((status IN ('running', 'recovery_required') AND stop_reason IS NULL AND completed_at IS NULL)",
  "    OR (status = 'done' AND stop_reason = 'completed' AND completed_at IS NOT NULL)",
  "    OR (status = 'failed' AND stop_reason = 'failed' AND completed_at IS NOT NULL)",
  "    OR (status = 'blocked' AND stop_reason = 'blocked' AND completed_at IS NOT NULL)",
  "    OR (status = 'needs_user_input' AND stop_reason = 'needs_user_input' AND completed_at IS NOT NULL)",
  "    OR (status = 'incomplete' AND stop_reason IN ('run_limit', 'context_limit', 'interrupted') AND completed_at IS NOT NULL)),",
  "  UNIQUE(stream_id, run_sequence),",
  "  FOREIGN KEY (workstream_id, bound_request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE UNIQUE INDEX runs_one_active_per_stream ON runs(stream_id)",
  "WHERE status IN ('running', 'recovery_required');",
  "CREATE TABLE context_checkpoints (",
  "  checkpoint_id TEXT PRIMARY KEY,",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  previous_checkpoint_id TEXT REFERENCES context_checkpoints(checkpoint_id),",
  "  covered_from_seq INTEGER NOT NULL CHECK (covered_from_seq >= 1),",
  "  covered_to_seq INTEGER NOT NULL CHECK (covered_to_seq >= covered_from_seq),",
  "  source_hash TEXT NOT NULL,",
  "  schema_version INTEGER NOT NULL CHECK (schema_version = 1),",
  "  summary_json TEXT NOT NULL,",
  "  exact_anchors_json TEXT NOT NULL,",
  "  token_count INTEGER NOT NULL CHECK (token_count > 0),",
  "  reason TEXT NOT NULL CHECK (reason = 'context_pressure'),",
  "  provider TEXT NOT NULL,",
  "  model TEXT NOT NULL,",
  "  created_at TEXT NOT NULL,",
  "  UNIQUE(stream_id, covered_to_seq, source_hash)",
  ");",
  "CREATE INDEX context_checkpoints_stream ON context_checkpoints(stream_id, covered_to_seq DESC);",
  "",
  "CREATE TABLE workstream_accesses (",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id) ON DELETE CASCADE,",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,",
  "  access_kind TEXT NOT NULL CHECK (access_kind IN ('opened', 'bound')),",
  "  accessed_at TEXT NOT NULL,",
  "  PRIMARY KEY(workstream_id, run_id, access_kind)",
  ");",
  "CREATE INDEX workstream_accesses_recent ON workstream_accesses(workstream_id, accessed_at DESC);",
  "CREATE INDEX workstream_accesses_frequency ON workstream_accesses(access_kind, accessed_at DESC, workstream_id);",
  "",
  "CREATE VIRTUAL TABLE workstream_search USING fts5(",
  "  workstream_id UNINDEXED, title, aliases, purpose, current_snapshot, current_focus,",
  "  findings, unfinished_requests, resources, recent_progress,",
  "  tokenize = 'unicode61 remove_diacritics 2'",
  ");",
  "",
  "CREATE TABLE resources (",
  "  resource_id TEXT PRIMARY KEY CHECK (resource_id GLOB 'RES-[0-9A-F][0-9A-F]*'),",
  "  kind TEXT NOT NULL CHECK (kind IN ('file', 'directory', 'document', 'image', 'audio', 'video', 'dataset', 'database', 'git_repository', 'url', 'external_object')),",
  "  origin TEXT NOT NULL CHECK (origin IN ('user_attachment', 'user_reference', 'agent_created', 'agent_discovered', 'agent_download')),",
  "  locator_kind TEXT NOT NULL CHECK (locator_kind IN ('filesystem', 'managed_blob', 'url', 'external')),",
  "  locator_key TEXT NOT NULL UNIQUE,",
  "  locator_json TEXT NOT NULL,",
  "  display_name TEXT NOT NULL,",
  "  description TEXT NOT NULL,",
  "  aliases_json TEXT NOT NULL,",
  "  metadata_status TEXT NOT NULL CHECK (metadata_status IN ('fallback', 'enriched', 'stale')),",
  "  described_version_key TEXT,",
  "  media_type TEXT,",
  "  size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),",
  "  content_hash TEXT,",
  "  current_version_key TEXT NOT NULL,",
  "  current_version_json TEXT NOT NULL,",
  "  availability TEXT NOT NULL CHECK (availability IN ('available', 'missing', 'changed', 'deleted', 'unverified')),",
  "  metadata_json TEXT NOT NULL DEFAULT '{}',",
  "  created_by_run_id TEXT REFERENCES runs(run_id),",
  "  last_verified_run_id TEXT REFERENCES runs(run_id),",
  "  last_verified_at TEXT,",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL",
  ");",
  "CREATE INDEX resources_updated_at ON resources(updated_at DESC);",
  "CREATE INDEX resources_kind ON resources(kind, availability, updated_at DESC);",
  "CREATE INDEX resources_content_hash ON resources(content_hash) WHERE content_hash IS NOT NULL;",
  "",
  "CREATE VIRTUAL TABLE resource_search USING fts5(",
  "  resource_id UNINDEXED, display_name, description, aliases, locator_text,",
  "  tokenize = 'unicode61 remove_diacritics 2'",
  ");",
  "",
  "CREATE TABLE message_resources (",
  "  message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,",
  "  resource_id TEXT NOT NULL REFERENCES resources(resource_id) ON DELETE CASCADE,",
  "  role TEXT NOT NULL CHECK (role IN ('attachment', 'reference')),",
  "  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),",
  "  created_at TEXT NOT NULL,",
  "  PRIMARY KEY(message_id, resource_id, role)",
  ");",
  "CREATE INDEX message_resources_resource ON message_resources(resource_id, created_at DESC);",
  "",
  "CREATE TABLE workstream_resources (",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id) ON DELETE CASCADE,",
  "  resource_id TEXT NOT NULL REFERENCES resources(resource_id) ON DELETE CASCADE,",
  "  role TEXT NOT NULL CHECK (role IN ('input', 'reference', 'primary', 'supporting', 'output', 'deliverable', 'evidence', 'asset')),",
  "  access TEXT NOT NULL CHECK (access IN ('read', 'mutate')),",
  "  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),",
  "  first_bound_run_id TEXT REFERENCES runs(run_id),",
  "  last_used_run_id TEXT REFERENCES runs(run_id),",
  "  bound_at TEXT NOT NULL,",
  "  last_used_at TEXT NOT NULL,",
  "  PRIMARY KEY(workstream_id, resource_id)",
  ");",
  "CREATE UNIQUE INDEX workstream_resources_one_primary ON workstream_resources(workstream_id)",
  "WHERE is_primary = 1;",
  "CREATE INDEX workstream_resources_by_resource ON workstream_resources(resource_id, last_used_at DESC);",
  "",
  "CREATE TABLE request_resources (",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id) ON DELETE CASCADE,",
  "  request_id TEXT NOT NULL,",
  "  resource_id TEXT NOT NULL REFERENCES resources(resource_id) ON DELETE CASCADE,",
  "  role TEXT NOT NULL CHECK (role IN ('input', 'reference', 'primary', 'supporting', 'output', 'deliverable', 'evidence', 'asset')),",
  "  created_by_run_id TEXT REFERENCES runs(run_id),",
  "  created_at TEXT NOT NULL,",
  "  PRIMARY KEY(workstream_id, request_id, resource_id, role),",
  "  FOREIGN KEY (workstream_id, request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id) ON DELETE CASCADE",
  ");",
  "CREATE INDEX request_resources_by_resource ON request_resources(resource_id, created_at DESC);",
  "",
  "CREATE TABLE resource_accesses (",
  "  resource_id TEXT NOT NULL REFERENCES resources(resource_id) ON DELETE CASCADE,",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,",
  "  access_kind TEXT NOT NULL CHECK (access_kind IN ('opened', 'read', 'used', 'mutated', 'delivered')),",
  "  accessed_at TEXT NOT NULL,",
  "  PRIMARY KEY(resource_id, run_id, access_kind)",
  ");",
  "CREATE INDEX resource_accesses_recent ON resource_accesses(resource_id, accessed_at DESC);",
  "",
  "CREATE TABLE resource_events (",
  "  event_id TEXT PRIMARY KEY,",
  "  resource_id TEXT NOT NULL REFERENCES resources(resource_id),",
  "  workstream_id TEXT REFERENCES workstreams(workstream_id),",
  "  bound_request_id TEXT,",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
  "  step INTEGER,",
  "  call_id TEXT,",
  "  event_type TEXT NOT NULL CHECK (event_type IN ('registered', 'linked', 'observed', 'created', 'modified', 'moved', 'deleted', 'missing', 'restored', 'downloaded', 'uploaded', 'delivered', 'external_state_changed')),",
  "  before_version_json TEXT,",
  "  after_version_json TEXT,",
  "  verification_json TEXT NOT NULL,",
  "  summary TEXT NOT NULL,",
  "  created_at TEXT NOT NULL,",
  "  FOREIGN KEY (workstream_id, bound_request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE INDEX resource_events_resource ON resource_events(resource_id, created_at DESC);",
  "CREATE INDEX resource_events_run ON resource_events(run_id, created_at, event_id);",
  "",
  "CREATE TABLE run_steps (",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
  "  step INTEGER NOT NULL,",
  "  record_version INTEGER NOT NULL CHECK (record_version = 1),",
  "  status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'blocked')),",
  "  summary TEXT NOT NULL,",
  "  decision_json TEXT,",
  "  action_json TEXT,",
  "  tool_calls_json TEXT NOT NULL,",
  "  verification_json TEXT NOT NULL,",
  "  created_at TEXT NOT NULL,",
  "  PRIMARY KEY(run_id, step)",
  ");",
  "",
  "CREATE TABLE run_work_state (",
  "  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),",
  "  revision INTEGER NOT NULL,",
  "  after_step INTEGER NOT NULL,",
  "  status TEXT NOT NULL CHECK (status IN ('in_progress', 'done', 'blocked', 'needs_user_input')),",
  "  summary TEXT NOT NULL,",
  "  plan_json TEXT NOT NULL,",
  "  important_context_json TEXT NOT NULL,",
  "  next_action TEXT,",
  "  update_reason TEXT NOT NULL CHECK (update_reason IN ('initial', 'plan', 'context_pressure', 'run_completed', 'run_paused', 'continuation')),",
  "  updated_at TEXT NOT NULL",
  ");",
  "",
  "CREATE TABLE resource_mutation_leases (",
  "  lease_id TEXT PRIMARY KEY,",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id),",
  "  bound_request_id TEXT NOT NULL,",
  "  lock_token_hash TEXT NOT NULL,",
  "  status TEXT NOT NULL CHECK (status IN ('active', 'recovery_required', 'released')),",
  "  acquired_at TEXT NOT NULL,",
  "  expires_at TEXT NOT NULL,",
  "  released_at TEXT,",
  "  last_error TEXT,",
  "  FOREIGN KEY (workstream_id, bound_request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE UNIQUE INDEX resource_mutation_leases_one_run ON resource_mutation_leases(run_id)",
  "WHERE status IN ('active', 'recovery_required');",
  "CREATE UNIQUE INDEX resource_mutation_leases_one_workstream ON resource_mutation_leases(workstream_id)",
  "WHERE status IN ('active', 'recovery_required');",
  "",
  "CREATE TABLE resource_mutation_locks (",
  "  lease_id TEXT NOT NULL REFERENCES resource_mutation_leases(lease_id) ON DELETE CASCADE,",
  "  resource_id TEXT NOT NULL REFERENCES resources(resource_id),",
  "  canonical_scope TEXT NOT NULL,",
  "  acquired_at TEXT NOT NULL,",
  "  PRIMARY KEY(lease_id, resource_id, canonical_scope)",
  ");",
  "CREATE INDEX resource_mutation_locks_resource ON resource_mutation_locks(resource_id, canonical_scope);",
  "",
  "CREATE TABLE resource_mutation_operations (",
  "  operation_id TEXT PRIMARY KEY,",
  "  lease_id TEXT NOT NULL REFERENCES resource_mutation_leases(lease_id),",
  "  run_id TEXT NOT NULL REFERENCES runs(run_id),",
  "  call_id TEXT NOT NULL,",
  "  tool TEXT NOT NULL,",
  "  effect TEXT NOT NULL CHECK (effect IN ('workspace_mutation', 'external_mutation', 'destructive')),",
  "  targets_json TEXT NOT NULL,",
  "  before_json TEXT NOT NULL,",
  "  after_json TEXT,",
  "  verification_json TEXT,",
  "  event_plan_json TEXT,",
  "  tool_status TEXT CHECK (tool_status IN ('completed', 'failed')),",
  "  status TEXT NOT NULL CHECK (status IN ('prepared', 'verified', 'no_change', 'recovery_required')),",
  "  created_at TEXT NOT NULL,",
  "  verified_at TEXT,",
  "  last_error TEXT,",
  "  UNIQUE(run_id, call_id)",
  ");",
  "CREATE INDEX resource_mutation_operations_lease ON resource_mutation_operations(lease_id, created_at);",
  "",
  "CREATE TABLE unbound_run_finalizations (",
  "  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),",
  "  operation_request_id TEXT NOT NULL UNIQUE REFERENCES idempotency_requests(request_id),",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'completed', 'recovery_required')),",
  "  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'incomplete', 'failed', 'blocked', 'needs_user_input')),",
  "  stop_reason TEXT NOT NULL CHECK (stop_reason IN ('completed', 'run_limit', 'context_limit', 'failed', 'blocked', 'needs_user_input', 'interrupted')),",
  "  assistant_message_id TEXT REFERENCES messages(message_id),",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  last_error TEXT",
  ");",
  "CREATE INDEX unbound_run_finalizations_recovery ON unbound_run_finalizations(phase, updated_at);",
  "",
  "CREATE TABLE workstream_request_route_plans (",
  "  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),",
  "  operation_request_id TEXT NOT NULL UNIQUE,",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id),",
  "  bound_request_id TEXT NOT NULL,",
  "  base_head TEXT NOT NULL,",
  "  route_json TEXT NOT NULL,",
  "  change_plan_json TEXT,",
  "  phase TEXT NOT NULL CHECK (phase IN ('planned', 'committed', 'discarded', 'recovery_required')),",
  "  commit_head TEXT,",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  last_error TEXT,",
  "  FOREIGN KEY (workstream_id, bound_request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE UNIQUE INDEX workstream_request_route_plans_active_workstream ON workstream_request_route_plans(workstream_id)",
  "WHERE phase IN ('planned', 'recovery_required');",
  "CREATE INDEX workstream_request_route_plans_recovery ON workstream_request_route_plans(phase, updated_at);",
  "",
  "CREATE TABLE workstream_finalizations (",
  "  run_id TEXT PRIMARY KEY REFERENCES runs(run_id),",
  "  operation_request_id TEXT NOT NULL UNIQUE REFERENCES idempotency_requests(request_id),",
  "  lease_id TEXT REFERENCES resource_mutation_leases(lease_id),",
  "  stream_id TEXT NOT NULL REFERENCES agent_streams(stream_id),",
  "  workstream_id TEXT NOT NULL REFERENCES workstreams(workstream_id),",
  "  bound_request_id TEXT NOT NULL,",
  "  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'resource_effects_recorded', 'context_committed', 'completed', 'recovery_required')),",
  "  outcome TEXT NOT NULL CHECK (outcome IN ('done', 'incomplete', 'failed', 'blocked', 'needs_user_input')),",
  "  stop_reason TEXT NOT NULL CHECK (stop_reason IN ('completed', 'run_limit', 'context_limit', 'failed', 'blocked', 'needs_user_input', 'interrupted')),",
  "  validation TEXT NOT NULL CHECK (validation IN ('passed', 'failed', 'not_applicable')),",
  "  summary TEXT NOT NULL,",
  "  next_action TEXT,",
  "  completion_json TEXT NOT NULL,",
  "  request_effect_json TEXT NOT NULL,",
  "  assistant_response TEXT NOT NULL,",
  "  base_head TEXT NOT NULL,",
  "  workstream_base_head TEXT NOT NULL,",
  "  message_hash TEXT NOT NULL,",
  "  plan_json TEXT NOT NULL,",
  "  resource_events_json TEXT NOT NULL DEFAULT '[]',",
  "  commit_head TEXT,",
  "  commit_created INTEGER NOT NULL DEFAULT 0 CHECK (commit_created IN (0, 1)),",
  "  created_at TEXT NOT NULL,",
  "  updated_at TEXT NOT NULL,",
  "  last_error TEXT,",
  "  FOREIGN KEY (workstream_id, bound_request_id)",
  "    REFERENCES workstream_requests(workstream_id, request_id)",
  ");",
  "CREATE INDEX workstream_finalizations_recovery ON workstream_finalizations(phase, updated_at);",
  RUN_WORKSTREAM_BINDING_IMMUTABLE_TRIGGER_SQL,
].join("\n");

export function initializeSchema(database: DatabaseSync, now: () => string): void {
  const existingTables = readTableNames(database);
  if (existingTables.length === 0) {
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(BASELINE_SQL);
      database.prepare(
        "INSERT INTO schema_metadata(singleton, version, created_at) VALUES (1, ?, ?)",
      ).run(SCHEMA_VERSION, now());
      database.exec("COMMIT");
      return;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  const versions = existingTables.includes("schema_metadata")
    ? database.prepare("SELECT version FROM schema_metadata WHERE singleton = 1").all() as Array<{
        version: number;
      }>
    : [];
  const currentVersion = Number(versions[0]?.version);
  if (matchesPreV12Tables(existingTables)) {
    if (currentVersion === 9) {
      migrateV9ToV10(database);
      migrateV10ToV11(database);
      migrateV11ToV12(database);
      return;
    }
    if (currentVersion === FOCUS_SCHEMA_VERSION) {
      migrateV10ToV11(database);
      migrateV11ToV12(database);
      return;
    }
    if (currentVersion === BINDING_SCHEMA_VERSION) {
      migrateV11ToV12(database);
      return;
    }
  }
  const versionMatches = versions.length === 1
    && Number(versions[0]?.version) === SCHEMA_VERSION;
  const tablesMatch = matchesSupportedTables(existingTables);
  if (!versionMatches || !tablesMatch) {
    throw new Error([
      "Context Engine database reset required.",
      "The configured database uses a pre-V9 or unsupported schema and was not modified.",
      "Run the shared-workstream migration or context:archive-reset explicitly, then restart Ayati to create the V12 baseline.",
    ].join(" "));
  }
}

function migrateV9ToV10(database: DatabaseSync): void {
  const columns = readTableColumns(database, "agent_streams");
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!columns.includes("focused_workstream_id")) {
      database.exec("ALTER TABLE agent_streams ADD COLUMN focused_workstream_id TEXT");
    }
    if (!columns.includes("focused_request_id")) {
      database.exec("ALTER TABLE agent_streams ADD COLUMN focused_request_id TEXT");
    }
    database.prepare(
      "UPDATE schema_metadata SET version = ? WHERE singleton = 1 AND version = 9",
    ).run(FOCUS_SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateV10ToV11(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP TRIGGER IF EXISTS runs_workstream_binding_immutable");
    database.exec(RUN_WORKSTREAM_BINDING_IMMUTABLE_TRIGGER_SQL);
    database.prepare(
      "UPDATE schema_metadata SET version = ? WHERE singleton = 1 AND version = ?",
    ).run(BINDING_SCHEMA_VERSION, FOCUS_SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function migrateV11ToV12(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DROP TABLE workstream_resolution_steps");
    database.exec("DROP TABLE workstream_resolution_activities");
    database.prepare(
      "UPDATE schema_metadata SET version = ? WHERE singleton = 1 AND version = ?",
    ).run(SCHEMA_VERSION, BINDING_SCHEMA_VERSION);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function matchesSupportedTables(existingTables: string[]): boolean {
  const currentTables = [...BASELINE_TABLES];
  const tablesWithRetiredObservations = [
    ...BASELINE_TABLES,
    ...RETIRED_OBSERVATION_TABLES,
  ].sort();
  return JSON.stringify(existingTables) === JSON.stringify(currentTables)
    || JSON.stringify(existingTables) === JSON.stringify(tablesWithRetiredObservations);
}

function matchesPreV12Tables(existingTables: string[]): boolean {
  const preV12Tables = [
    ...BASELINE_TABLES,
    ...RETIRED_RESOLUTION_TABLES,
  ].sort();
  const preV12TablesWithRetiredObservations = [
    ...preV12Tables,
    ...RETIRED_OBSERVATION_TABLES,
  ].sort();
  return JSON.stringify(existingTables) === JSON.stringify(preV12Tables)
    || JSON.stringify(existingTables) === JSON.stringify(preV12TablesWithRetiredObservations);
}

export function latestSchemaVersion(): number {
  return SCHEMA_VERSION;
}

function readTableNames(database: DatabaseSync): string[] {
  const rows = database.prepare([
    "SELECT name FROM sqlite_schema",
    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    "AND name NOT GLOB 'workstream_search_*'",
    "AND name NOT GLOB 'workstream_request_search_*'",
    "AND name NOT GLOB 'resource_search_*'",
    "AND name NOT GLOB 'message_search_*'",
    "ORDER BY name",
  ].join(" ")).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function readTableColumns(database: DatabaseSync, table: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}
