import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  autoLoadUntil,
  classifyLifecycle,
  defaultImportance,
  hasExplicitNewTaskSignal,
  inferActivityKind,
  shouldCreateActivity,
} from "./policy.js";
import type {
  ActivityAlias,
  ActivityAssetKind,
  ActivityAssetOrigin,
  ActivityAssetRef,
  ActivityAssetRole,
  ActivityCue,
  ActivityCueType,
  ActivityDiscussionRange,
  ActivityEntity,
  ActivityEntityType,
  ActivityIdentity,
  ActivityIdentityType,
  ActivityKind,
  ActivityLifecycle,
  ActivityRunRef,
  ActivitySearchOptions,
  ActivityState,
  ActivityStateRunSummary,
  ActivityStatus,
  ActivityTaskBoundary,
  ActivityThread,
  ActivityUpsertInput,
} from "./types.js";

const thisDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(thisDir, "..", "..", "..");
const DEFAULT_DATA_DIR = resolve(projectRoot, "data", "memory");

export interface ActivityStoreOptions {
  dataDir?: string;
  dbPath?: string;
  now?: () => Date;
}

interface ActivityRow {
  activity_id: string;
  client_id: string;
  kind: ActivityKind;
  title: string;
  summary: string;
  lifecycle: ActivityLifecycle;
  state_json: string;
  confidence: number;
  importance: number;
  reuse_count: number;
  created_at: string;
  last_touched_at: string;
  auto_load_until: string | null;
  details_json: string;
}

interface IdentityRow {
  activity_id: string;
  type: ActivityIdentityType;
  value: string;
  confidence: number;
  source: ActivityIdentity["source"];
  last_seen_at: string;
}

interface AliasRow {
  activity_id: string;
  value: string;
  confidence: number;
  source: ActivityAlias["source"];
  last_seen_at: string;
}

interface CueRow {
  activity_id: string;
  cue_type: ActivityCueType;
  cue_text: string;
  normalized_cue: string;
  weight: number;
  source: ActivityCue["source"];
  last_seen_at: string;
}

interface EntityRow {
  activity_id: string;
  entity_type: ActivityEntityType;
  name: string;
  normalized_name: string;
  role: ActivityEntity["role"];
  confidence: number;
  source: ActivityEntity["source"];
  last_seen_at: string;
}

interface AssetRow {
  activity_id: string;
  asset_id: string;
  kind: ActivityAssetKind;
  origin: ActivityAssetOrigin;
  role: ActivityAssetRole;
  display_name: string | null;
  path: string | null;
  uri: string | null;
  document_id: string | null;
  file_id: string | null;
  directory_id: string | null;
  prepared_input_id: string | null;
  manifest_json: string;
  summary_json: string;
  detail_json: string;
  restore_json: string;
  source_run_id: string;
  source_run_path: string;
  last_used_run_id: string;
  last_used_at: string;
  metadata_json: string;
}

interface RunRow {
  activity_id: string;
  run_id: string;
  session_id: string;
  run_path: string;
  trigger_seq: number | null;
  discussion_start_seq: number | null;
  discussion_end_seq: number | null;
  status: ActivityRunRef["status"];
  task_status: string | null;
  user_message: string | null;
  assistant_response: string | null;
  summary: string;
  tools_used_json: string;
  asset_ids_json: string;
  created_at: string;
}

interface BoundaryRow {
  activity_id: string;
  run_id: string;
  session_id: string;
  kind: ActivityKind;
  state_json: string;
  created_at: string;
  trigger_seq: number | null;
  discussion_start_seq: number | null;
  discussion_end_seq: number | null;
}

export class ActivityStore {
  private readonly dbPath: string;
  private readonly nowProvider: () => Date;
  private db: DatabaseSync | null = null;

  constructor(options?: ActivityStoreOptions) {
    const dataDir = options?.dataDir ?? DEFAULT_DATA_DIR;
    this.dbPath = options?.dbPath ?? resolve(dataDir, "memory.sqlite");
    this.nowProvider = options?.now ?? (() => new Date());
  }

  start(): void {
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA synchronous=NORMAL;");
    this.createSchema();
  }

  stop(): void {
    this.db?.close();
    this.db = null;
  }

  upsertFromTaskSummary(input: ActivityUpsertInput): ActivityThread | null {
    const kind = inferActivityKind(input);
    if (!shouldCreateActivity(input, kind)) {
      return null;
    }

    const now = this.nowProvider();
    const existing = this.findActivityForUpsert(input, kind);
    const previous = existing ? this.getActivity(existing.activityId) : null;
    const title = previous?.title ?? buildTitle(input, kind);
    const activityId = previous?.activityId ?? stableActivityId(
      input.clientId,
      input.sessionId,
      kind === "ephemeral" ? `${title}:${input.runId}` : title,
      kind,
    );
    const summary = buildSummary(input, previous?.summary);
    const identities = mergeIdentities(previous?.identities ?? [], buildIdentities(input), input.createdAt);
    const aliases = mergeAliases(previous?.aliases ?? [], buildAliases(input, title), input.createdAt);
    const assets = mergeAssets(previous?.assets ?? [], collectAssets(input)).slice(-40);
    const discussionRanges = mergeDiscussionRanges(
      previous?.discussionRanges ?? [],
      buildDiscussionRange(input, previous !== null),
    );
    const state = buildState(input, previous?.state, assets);
    const cues = mergeCues(previous?.cues ?? [], buildCues(input, title, summary, state, assets), input.createdAt);
    const entities = mergeEntities(previous?.entities ?? [], buildEntities(input, kind, assets), input.createdAt);
    const reuseCount = previous ? previous.reuseCount + 1 : 1;
    const importance = Math.max(previous?.importance ?? defaultImportance(kind), defaultImportance(kind));
    const lifecycle = classifyLifecycle({
      kind,
      lastTouchedAt: input.createdAt,
      openWorkCount: state.openWork.length,
      reuseCount,
      now,
    });
    const thread: ActivityThread = {
      activityId,
      clientId: input.clientId,
      kind,
      title,
      summary,
      lifecycle,
      identities,
      aliases,
      cues,
      entities,
      assets,
      runs: appendRun(previous?.runs ?? [], buildRun(input, assets)),
      discussionRanges,
      state,
      confidence: previous ? Math.min(0.99, previous.confidence + 0.04) : initialConfidence(input),
      importance,
      reuseCount,
      createdAt: previous?.createdAt ?? input.createdAt,
      lastTouchedAt: input.createdAt,
      autoLoadUntil: autoLoadUntil(kind, input.createdAt),
      details: {
        ...(previous?.details ?? {}),
        discussionRanges,
        lastAdmission: {
          kind,
          durableAnchors: identities.filter((identity) => identity.type !== "explicit_alias").length,
          assetCount: assets.length,
          cueCount: cues.length,
          entityCount: entities.length,
        },
      },
    };

    this.writeThread(thread, previous ? "updated" : "created", input.runId);
    return this.getActivity(activityId);
  }

  getActivity(activityId: string): ActivityThread | null {
    const row = this.requireDb()
      .prepare("SELECT * FROM activity_threads WHERE activity_id = ?")
      .get(activityId) as ActivityRow | undefined;
    return row ? this.toActivityThread(row) : null;
  }

  getActivityByIdentity(clientId: string, type: ActivityIdentityType, value: string): ActivityThread | null {
    const normalized = normalizeIdentityValue(type, value);
    if (!normalized) return null;
    const row = this.requireDb().prepare(`
      SELECT t.*
      FROM activity_identities i
      JOIN activity_threads t ON t.activity_id = i.activity_id
      WHERE i.client_id = ? AND i.type = ? AND i.value = ? AND t.lifecycle <> 'archived'
      ORDER BY i.confidence DESC, t.last_touched_at DESC
      LIMIT 1
    `).get(clientId, type, normalized) as ActivityRow | undefined;
    return row ? this.toActivityThread(row) : null;
  }

  findByIdentities(
    clientId: string,
    identities: Array<Pick<ActivityIdentity, "type" | "value">>,
    limit = 5,
  ): Array<{ activity: ActivityThread; matches: number }> {
    const normalized = identities
      .map((identity) => ({
        type: identity.type,
        value: normalizeIdentityValue(identity.type, identity.value),
      }))
      .filter((identity): identity is { type: ActivityIdentityType; value: string } => identity.value.length > 0);
    if (normalized.length === 0) return [];

    const found = new Map<string, { activity: ActivityThread; matches: number }>();
    for (const identity of normalized) {
      const rows = this.requireDb().prepare(`
        SELECT t.*
        FROM activity_identities i
        JOIN activity_threads t ON t.activity_id = i.activity_id
        WHERE i.client_id = ? AND i.type = ? AND i.value = ? AND t.lifecycle <> 'archived'
        ORDER BY i.confidence DESC, t.last_touched_at DESC
        LIMIT 5
      `).all(clientId, identity.type, identity.value) as unknown as ActivityRow[];
      for (const row of rows) {
        const activity = this.toActivityThread(row);
        const previous = found.get(activity.activityId);
        found.set(activity.activityId, {
          activity,
          matches: (previous?.matches ?? 0) + 1,
        });
      }
    }
    return [...found.values()]
      .sort((a, b) => b.matches - a.matches || b.activity.lastTouchedAt.localeCompare(a.activity.lastTouchedAt))
      .slice(0, Math.max(1, Math.min(10, limit)));
  }

  search(clientId: string, query: string, options?: ActivitySearchOptions): ActivityThread[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];
    const limit = Math.max(1, Math.min(20, options?.limit ?? 5));
    const candidates = new Map<string, { activity: ActivityThread; score: number }>();
    const includeArchivedSql = options?.includeArchived ? "" : "AND t.lifecycle <> 'archived'";
    const addRows = (rows: ActivityRow[], score: number): void => {
      for (const row of rows) {
        const activity = this.toActivityThread(row);
        const previous = candidates.get(activity.activityId);
        candidates.set(activity.activityId, {
          activity,
          score: (previous?.score ?? 0) + score,
        });
      }
    };

    const normalizedQuery = normalizeAlias(query);
    if (normalizedQuery) {
      addRows(this.requireDb().prepare(`
        SELECT DISTINCT t.*
        FROM activity_cues c
        JOIN activity_threads t ON t.activity_id = c.activity_id
        WHERE c.client_id = ? AND c.normalized_cue = ? ${includeArchivedSql}
        ORDER BY c.weight DESC, t.last_touched_at DESC
        LIMIT ?
      `).all(clientId, normalizedQuery, limit * 2) as unknown as ActivityRow[], 8);

      addRows(this.requireDb().prepare(`
        SELECT DISTINCT t.*
        FROM activity_entities e
        JOIN activity_threads t ON t.activity_id = e.activity_id
        WHERE e.client_id = ? AND e.normalized_name = ? ${includeArchivedSql}
        ORDER BY e.confidence DESC, t.last_touched_at DESC
        LIMIT ?
      `).all(clientId, normalizedQuery, limit * 2) as unknown as ActivityRow[], 7);

      addRows(this.requireDb().prepare(`
        SELECT DISTINCT t.*
        FROM activity_aliases a
        JOIN activity_threads t ON t.activity_id = a.activity_id
        WHERE a.client_id = ? AND a.value = ? ${includeArchivedSql}
        ORDER BY a.confidence DESC, t.last_touched_at DESC
        LIMIT ?
      `).all(clientId, normalizedQuery, limit * 2) as unknown as ActivityRow[], 6);
    }

    const ftsQuery = toFtsQuery(query);
    if (ftsQuery) {
      const rows = this.requireDb().prepare(`
        SELECT t.*
        FROM activity_search_fts
        JOIN activity_threads t ON t.activity_id = activity_search_fts.activity_id
        WHERE activity_search_fts.client_id = ?
          AND activity_search_fts MATCH ?
          ${includeArchivedSql}
        ORDER BY bm25(activity_search_fts, 8.0, 5.0, 3.0, 5.0, 5.0, 3.0, 3.0, 3.0), t.last_touched_at DESC
        LIMIT ?
      `).all(clientId, ftsQuery, limit * 4) as unknown as ActivityRow[];
      rows.forEach((row, index) => addRows([row], Math.max(1, 5 - index * 0.2)));
    }

    return [...candidates.values()]
      .map(({ activity, score }) => ({
        activity,
        score: score + tokenOverlapScore(terms, searchableText(activity)) + recencySearchBoost(activity, this.nowProvider()),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || b.activity.lastTouchedAt.localeCompare(a.activity.lastTouchedAt))
      .slice(0, limit)
      .map(({ activity }) => activity);
  }

  listRecent(clientId: string, limit = 5): ActivityThread[] {
    const rows = this.requireDb().prepare(`
      SELECT *
      FROM activity_threads
      WHERE client_id = ? AND lifecycle <> 'archived'
      ORDER BY last_touched_at DESC
      LIMIT ?
    `).all(clientId, Math.max(1, Math.min(20, limit))) as unknown as ActivityRow[];
    return rows.map((row) => this.toActivityThread(row));
  }

  listRecentForSession(clientId: string, sessionId: string, limit = 5): ActivityThread[] {
    const rows = this.requireDb().prepare(`
      SELECT DISTINCT t.*
      FROM activity_threads t
      JOIN activity_runs r ON r.activity_id = t.activity_id
      WHERE t.client_id = ? AND r.session_id = ? AND t.lifecycle <> 'archived'
      ORDER BY t.last_touched_at DESC
      LIMIT ?
    `).all(clientId, sessionId, Math.max(1, Math.min(20, limit))) as unknown as ActivityRow[];
    return rows.map((row) => this.toActivityThread(row));
  }

  findLatestDurableTaskBoundary(clientId: string, sessionId: string): ActivityTaskBoundary | null {
    const row = this.requireDb().prepare(`
      SELECT
        t.activity_id,
        r.run_id,
        r.session_id,
        t.kind,
        t.state_json,
        r.created_at,
        r.trigger_seq,
        r.discussion_start_seq,
        r.discussion_end_seq
      FROM activity_runs r
      JOIN activity_threads t ON t.activity_id = r.activity_id
      WHERE t.client_id = ? AND r.session_id = ? AND t.lifecycle <> 'archived'
      ORDER BY r.created_at DESC
      LIMIT 1
    `).get(clientId, sessionId) as BoundaryRow | undefined;
    if (!row) return null;
    const state = normalizeState(parseJsonObject(row.state_json));
    return {
      activityId: row.activity_id,
      runId: row.run_id,
      sessionId: row.session_id,
      kind: row.kind,
      createdAt: row.created_at,
      ...(typeof row.discussion_start_seq === "number" ? { startSeq: row.discussion_start_seq } : {}),
      ...(typeof row.discussion_end_seq === "number" ? { endSeq: row.discussion_end_seq } : {}),
      ...(state.status ? { status: state.status } : {}),
    };
  }

  updateActivity(input: {
    clientId: string;
    activityId: string;
    title?: string;
    summary?: string;
    openWork?: string[];
    verifiedFacts?: string[];
    nextStep?: string;
  }): ActivityThread | null {
    const activity = this.getActivity(input.activityId);
    if (!activity || activity.clientId !== input.clientId) return null;
    const now = this.nowProvider().toISOString();
    const state: ActivityState = {
      ...activity.state,
      ...(input.openWork ? { openWork: compactList(input.openWork, 8, 220) } : {}),
      verifiedFacts: compactList([
        ...activity.state.verifiedFacts,
        ...(input.verifiedFacts ?? []),
      ], 12, 220),
      ...(input.nextStep !== undefined ? { nextStep: input.nextStep.trim() || undefined } : {}),
    };
    const next: ActivityThread = {
      ...activity,
      ...(input.title?.trim() ? { title: compactText(input.title, 90) } : {}),
      ...(input.summary?.trim() ? { summary: compactText(input.summary, 900) } : {}),
      state,
      cues: mergeCues(activity.cues, buildManualUpdateCues({
        title: input.title ?? activity.title,
        summary: input.summary ?? activity.summary,
        openWork: state.openWork,
        verifiedFacts: state.verifiedFacts,
        nextStep: state.nextStep,
        now,
      }), now),
      entities: activity.entities,
      lastTouchedAt: now,
      lifecycle: classifyLifecycle({
        kind: activity.kind,
        lastTouchedAt: now,
        openWorkCount: state.openWork.length,
        reuseCount: activity.reuseCount,
        now: this.nowProvider(),
      }),
    };
    this.writeThread(next, "updated_by_tool", input.activityId);
    return this.getActivity(input.activityId);
  }

  archiveActivity(clientId: string, activityId: string): boolean {
    const activity = this.getActivity(activityId);
    if (!activity || activity.clientId !== clientId) return false;
    const now = this.nowProvider().toISOString();
    this.requireDb().prepare(`
      UPDATE activity_threads
      SET lifecycle = 'archived', last_touched_at = ?
      WHERE activity_id = ? AND client_id = ?
    `).run(now, activityId, clientId);
    this.writeEvent(activityId, clientId, activityId, "archived", {}, now);
    return true;
  }

  private findActivityForUpsert(input: ActivityUpsertInput, kind: ActivityKind): ActivityThread | null {
    if (input.activityId?.trim()) {
      const explicit = this.getActivity(input.activityId.trim());
      if (explicit?.clientId === input.clientId) return explicit;
    }
    if (kind === "ephemeral" || hasExplicitNewTaskSignal(input.userMessage ?? input.objective ?? "")) {
      return null;
    }
    const identityMatches = this.findByIdentities(input.clientId, buildIdentities(input), 1);
    return identityMatches[0]?.activity ?? null;
  }

  private writeThread(thread: ActivityThread, eventType: string, runId: string): void {
    const db = this.requireDb();
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.prepare(`
      INSERT INTO activity_threads (
        activity_id, client_id, kind, title, summary, lifecycle, state_json,
        confidence, importance, reuse_count, created_at, last_touched_at,
        auto_load_until, details_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(activity_id) DO UPDATE SET
        kind = excluded.kind,
        title = excluded.title,
        summary = excluded.summary,
        lifecycle = excluded.lifecycle,
        state_json = excluded.state_json,
        confidence = excluded.confidence,
        importance = excluded.importance,
        reuse_count = excluded.reuse_count,
        last_touched_at = excluded.last_touched_at,
        auto_load_until = excluded.auto_load_until,
        details_json = excluded.details_json
    `).run(
      thread.activityId,
      thread.clientId,
      thread.kind,
      thread.title,
      thread.summary,
      thread.lifecycle,
      JSON.stringify(thread.state),
      thread.confidence,
      thread.importance,
      thread.reuseCount,
      thread.createdAt,
      thread.lastTouchedAt,
      thread.autoLoadUntil ?? null,
      JSON.stringify(thread.details),
    );

      for (const identity of thread.identities) {
        db.prepare(`
        INSERT INTO activity_identities (
          activity_id, client_id, type, value, confidence, source, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id, type, value) DO UPDATE SET
          activity_id = excluded.activity_id,
          confidence = MAX(activity_identities.confidence, excluded.confidence),
          source = excluded.source,
          last_seen_at = excluded.last_seen_at
      `).run(thread.activityId, thread.clientId, identity.type, identity.value, identity.confidence, identity.source, identity.lastSeenAt);
      }

      for (const alias of thread.aliases) {
        db.prepare(`
        INSERT INTO activity_aliases (
          activity_id, client_id, value, confidence, source, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id, value) DO UPDATE SET
          activity_id = excluded.activity_id,
          confidence = MAX(activity_aliases.confidence, excluded.confidence),
          source = excluded.source,
          last_seen_at = excluded.last_seen_at
      `).run(thread.activityId, thread.clientId, alias.value, alias.confidence, alias.source, alias.lastSeenAt);
      }

      for (const cue of thread.cues) {
        db.prepare(`
        INSERT INTO activity_cues (
          activity_id, client_id, cue_type, cue_text, normalized_cue, weight, source, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id, cue_type, normalized_cue) DO UPDATE SET
          cue_text = excluded.cue_text,
          weight = MAX(activity_cues.weight, excluded.weight),
          source = excluded.source,
          last_seen_at = excluded.last_seen_at
      `).run(
          thread.activityId,
          thread.clientId,
          cue.cueType,
          cue.text,
          cue.normalizedText,
          cue.weight,
          cue.source,
          cue.lastSeenAt,
        );
      }

      for (const entity of thread.entities) {
        db.prepare(`
        INSERT INTO activity_entities (
          activity_id, client_id, entity_type, name, normalized_name, role, confidence, source, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id, entity_type, normalized_name, role) DO UPDATE SET
          name = excluded.name,
          confidence = MAX(activity_entities.confidence, excluded.confidence),
          source = excluded.source,
          last_seen_at = excluded.last_seen_at
      `).run(
          thread.activityId,
          thread.clientId,
          entity.entityType,
          entity.name,
          entity.normalizedName,
          entity.role,
          entity.confidence,
          entity.source,
          entity.lastSeenAt,
        );
      }

      for (const asset of thread.assets) {
        db.prepare(`
        INSERT INTO activity_assets (
          activity_id, asset_id, kind, origin, role, display_name, path, uri,
          document_id, file_id, directory_id, prepared_input_id, manifest_json,
          summary_json, detail_json, restore_json, source_run_id, source_run_path,
          last_used_run_id, last_used_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id, asset_id) DO UPDATE SET
          kind = excluded.kind,
          origin = excluded.origin,
          role = excluded.role,
          display_name = excluded.display_name,
          path = excluded.path,
          uri = excluded.uri,
          document_id = excluded.document_id,
          file_id = excluded.file_id,
          directory_id = excluded.directory_id,
          prepared_input_id = excluded.prepared_input_id,
          manifest_json = excluded.manifest_json,
          summary_json = excluded.summary_json,
          detail_json = excluded.detail_json,
          restore_json = excluded.restore_json,
          last_used_run_id = excluded.last_used_run_id,
          last_used_at = excluded.last_used_at,
          metadata_json = excluded.metadata_json
      `).run(
        thread.activityId,
        asset.assetId,
        asset.kind,
        asset.origin,
        asset.role,
        asset.displayName ?? null,
        asset.path ?? null,
        asset.uri ?? null,
        asset.documentId ?? null,
        asset.fileId ?? null,
        asset.directoryId ?? null,
        asset.preparedInputId ?? null,
        JSON.stringify(asset.manifest ?? null),
        JSON.stringify(asset.summary ?? null),
        JSON.stringify(asset.detail ?? null),
        JSON.stringify(asset.restore ?? null),
        asset.sourceRunId,
        asset.sourceRunPath,
        asset.lastUsedRunId,
        asset.lastUsedAt,
        JSON.stringify(asset.metadata ?? null),
      );
      }

      for (const run of thread.runs) {
        db.prepare(`
        INSERT INTO activity_runs (
          activity_id, run_id, session_id, run_path, trigger_seq,
          discussion_start_seq, discussion_end_seq, status, task_status,
          user_message, assistant_response, summary, tools_used_json,
          asset_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id, run_id) DO UPDATE SET
          session_id = excluded.session_id,
          run_path = excluded.run_path,
          trigger_seq = excluded.trigger_seq,
          discussion_start_seq = excluded.discussion_start_seq,
          discussion_end_seq = excluded.discussion_end_seq,
          status = excluded.status,
          task_status = excluded.task_status,
          user_message = excluded.user_message,
          assistant_response = excluded.assistant_response,
          summary = excluded.summary,
          tools_used_json = excluded.tools_used_json,
          asset_ids_json = excluded.asset_ids_json,
          created_at = excluded.created_at
      `).run(
        thread.activityId,
        run.runId,
        run.sessionId,
        run.runPath,
        run.triggerSeq ?? null,
        run.discussionStartSeq ?? null,
        run.discussionEndSeq ?? null,
        run.status,
        run.taskStatus ?? null,
        run.userMessage ?? null,
        run.assistantResponse ?? null,
        run.summary,
        JSON.stringify(run.toolsUsed),
        JSON.stringify(run.assetIds),
        run.createdAt,
      );
      }

      db.prepare("DELETE FROM activity_search_fts WHERE activity_id = ?").run(thread.activityId);
      db.prepare(`
        INSERT INTO activity_search_fts (
          activity_id, client_id, title, summary, state, cues, entities, aliases, assets
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        thread.activityId,
        thread.clientId,
        thread.title,
        thread.summary,
        activityStateSearchText(thread),
        thread.cues.map((cue) => cue.text).join("\n"),
        thread.entities.map((entity) => `${entity.entityType} ${entity.name}`).join("\n"),
        thread.aliases.map((alias) => alias.value).join("\n"),
        thread.assets.map(assetLabel).join("\n"),
      );

      this.writeEvent(thread.activityId, thread.clientId, runId, eventType, {
        title: thread.title,
        kind: thread.kind,
        lifecycle: thread.lifecycle,
      }, thread.lastTouchedAt);
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  private writeEvent(
    activityId: string,
    clientId: string,
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.requireDb().prepare(`
      INSERT INTO activity_events (id, activity_id, client_id, run_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), activityId, clientId, runId, eventType, JSON.stringify(payload), createdAt);
  }

  private toActivityThread(row: ActivityRow): ActivityThread {
    const details = parseJsonObject(row.details_json);
    const identities = this.requireDb().prepare(`
      SELECT * FROM activity_identities WHERE activity_id = ? ORDER BY confidence DESC, last_seen_at DESC
    `).all(row.activity_id) as unknown as IdentityRow[];
    const aliases = this.requireDb().prepare(`
      SELECT * FROM activity_aliases WHERE activity_id = ? ORDER BY confidence DESC, last_seen_at DESC
    `).all(row.activity_id) as unknown as AliasRow[];
    const cues = this.requireDb().prepare(`
      SELECT * FROM activity_cues WHERE activity_id = ? ORDER BY weight DESC, last_seen_at DESC
    `).all(row.activity_id) as unknown as CueRow[];
    const entities = this.requireDb().prepare(`
      SELECT * FROM activity_entities WHERE activity_id = ? ORDER BY confidence DESC, last_seen_at DESC
    `).all(row.activity_id) as unknown as EntityRow[];
    const assets = this.requireDb().prepare(`
      SELECT * FROM activity_assets WHERE activity_id = ? ORDER BY last_used_at DESC
    `).all(row.activity_id) as unknown as AssetRow[];
    const runs = this.requireDb().prepare(`
      SELECT * FROM activity_runs WHERE activity_id = ? ORDER BY created_at ASC
    `).all(row.activity_id) as unknown as RunRow[];
    return {
      activityId: row.activity_id,
      clientId: row.client_id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      lifecycle: row.lifecycle,
      identities: identities.map((identity) => ({
        type: identity.type,
        value: identity.value,
        confidence: Number(identity.confidence ?? 0),
        source: identity.source,
        lastSeenAt: identity.last_seen_at,
      })),
      aliases: aliases.map((alias) => ({
        value: alias.value,
        confidence: Number(alias.confidence ?? 0),
        source: alias.source,
        lastSeenAt: alias.last_seen_at,
      })),
      cues: cues.map((cue) => ({
        cueType: cue.cue_type,
        text: cue.cue_text,
        normalizedText: cue.normalized_cue,
        weight: Number(cue.weight ?? 0),
        source: cue.source,
        lastSeenAt: cue.last_seen_at,
      })),
      entities: entities.map((entity) => ({
        entityType: entity.entity_type,
        name: entity.name,
        normalizedName: entity.normalized_name,
        role: entity.role,
        confidence: Number(entity.confidence ?? 0),
        source: entity.source,
        lastSeenAt: entity.last_seen_at,
      })),
      assets: assets.map(rowToAsset),
      runs: runs.map(rowToRun),
      discussionRanges: readDiscussionRanges(details["discussionRanges"]),
      state: normalizeState(parseJsonObject(row.state_json)),
      confidence: Number(row.confidence ?? 0),
      importance: Number(row.importance ?? 0),
      reuseCount: Number(row.reuse_count ?? 0),
      createdAt: row.created_at,
      lastTouchedAt: row.last_touched_at,
      ...(row.auto_load_until ? { autoLoadUntil: row.auto_load_until } : {}),
      details,
    };
  }

  private createSchema(): void {
    const db = this.requireDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_threads (
        activity_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        state_json TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        reuse_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_touched_at TEXT NOT NULL,
        auto_load_until TEXT,
        details_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_threads_client_recent
        ON activity_threads(client_id, lifecycle, last_touched_at DESC);

      CREATE TABLE IF NOT EXISTS activity_identities (
        activity_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        type TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(client_id, type, value)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_identities_activity
        ON activity_identities(activity_id);

      CREATE TABLE IF NOT EXISTS activity_aliases (
        activity_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        UNIQUE(client_id, value)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_aliases_activity
        ON activity_aliases(activity_id);

      CREATE TABLE IF NOT EXISTS activity_cues (
        activity_id TEXT NOT NULL REFERENCES activity_threads(activity_id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        cue_type TEXT NOT NULL,
        cue_text TEXT NOT NULL,
        normalized_cue TEXT NOT NULL,
        weight INTEGER NOT NULL,
        source TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(activity_id, cue_type, normalized_cue)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_cues_lookup
        ON activity_cues(client_id, normalized_cue, cue_type);
      CREATE INDEX IF NOT EXISTS idx_activity_cues_activity
        ON activity_cues(activity_id);

      CREATE TABLE IF NOT EXISTS activity_entities (
        activity_id TEXT NOT NULL REFERENCES activity_threads(activity_id) ON DELETE CASCADE,
        client_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        role TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY(activity_id, entity_type, normalized_name, role)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_entities_lookup
        ON activity_entities(client_id, normalized_name, entity_type);
      CREATE INDEX IF NOT EXISTS idx_activity_entities_activity
        ON activity_entities(activity_id);

      CREATE TABLE IF NOT EXISTS activity_assets (
        activity_id TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        origin TEXT NOT NULL,
        role TEXT NOT NULL,
        display_name TEXT,
        path TEXT,
        uri TEXT,
        document_id TEXT,
        file_id TEXT,
        directory_id TEXT,
        prepared_input_id TEXT,
        manifest_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        restore_json TEXT NOT NULL,
        source_run_id TEXT NOT NULL,
        source_run_path TEXT NOT NULL,
        last_used_run_id TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        PRIMARY KEY(activity_id, asset_id)
      );

      CREATE TABLE IF NOT EXISTS activity_runs (
        activity_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_path TEXT NOT NULL,
        trigger_seq INTEGER,
        discussion_start_seq INTEGER,
        discussion_end_seq INTEGER,
        status TEXT NOT NULL,
        task_status TEXT,
        user_message TEXT,
        assistant_response TEXT,
        summary TEXT NOT NULL,
        tools_used_json TEXT NOT NULL,
        asset_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(activity_id, run_id)
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_events_activity
        ON activity_events(activity_id, created_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS activity_search_fts USING fts5(
        activity_id UNINDEXED,
        client_id UNINDEXED,
        title,
        summary,
        state,
        cues,
        entities,
        aliases,
        assets,
        tokenize = 'unicode61'
      );
    `);
  }

  private requireDb(): DatabaseSync {
    if (!this.db) {
      throw new Error("ActivityStore not started");
    }
    return this.db;
  }

}

export function buildIdentities(input: ActivityUpsertInput): ActivityIdentity[] {
  const at = input.createdAt;
  const identities: ActivityIdentity[] = [];
  for (const asset of input.activityAssets ?? []) {
    addIdentity(identities, "asset_id", asset.assetId, 0.99, "asset", at);
    addIdentity(identities, "prepared_input_id", asset.preparedInputId, 0.98, "asset", at);
    addIdentity(identities, "document_id", asset.documentId, 0.98, "asset", at);
    addIdentity(identities, asset.kind === "dataset" ? "dataset_id" : "document_id", asset.summary?.documentId, 0.96, "asset", at);
    addIdentity(identities, "file_id", asset.fileId, 0.98, "asset", at);
    addIdentity(identities, "directory_id", asset.directoryId, 0.98, "asset", at);
    addIdentity(identities, "file_path", asset.path, 0.94, "asset", at);
    addIdentity(identities, "file_path", asset.restore?.filePath, 0.96, "asset", at);
    addIdentity(identities, "directory_path", asset.restore?.directoryPath, 0.96, "asset", at);
    addIdentity(identities, "directory_path", asset.path && asset.kind === "directory" ? asset.path : undefined, 0.94, "asset", at);
    addIdentity(identities, "explicit_alias", asset.displayName, 0.72, "alias", at);
  }
  for (const alias of input.attachmentNames ?? []) {
    addIdentity(identities, "explicit_alias", alias, 0.7, "alias", at);
  }
  for (const path of extractPathLikeValues([
    input.objective,
    input.summary,
    input.progressSummary,
    ...(input.attachmentNames ?? []),
    ...(input.activityAssets ?? []).map((asset) => asset.displayName),
    ...(input.keyFacts ?? []),
    ...(input.evidence ?? []),
    ...(input.completedMilestones ?? []),
    input.userMessage,
  ].join("\n"))) {
    addIdentity(identities, path.endsWith("/") ? "directory_path" : "file_path", path, 0.74, "inferred", at);
  }
  return dedupeIdentities(identities);
}

export function extractMessageIdentities(message: string, createdAt: string): ActivityIdentity[] {
  return dedupeIdentities(extractPathLikeValues(message).map((path) => ({
    type: path.endsWith("/") ? "directory_path" : "file_path",
    value: normalizeIdentityValue(path.endsWith("/") ? "directory_path" : "file_path", path),
    confidence: 0.78,
    source: "explicit",
    lastSeenAt: createdAt,
  })));
}

export function normalizeIdentityValue(type: ActivityIdentityType, value: string | undefined): string {
  const trimmed = value?.replace(/\s+/g, " ").trim() ?? "";
  if (!trimmed) return "";
  if (type === "explicit_alias") return normalizeAlias(trimmed);
  if (type === "file_path" || type === "directory_path" || type === "workspace_root" || type === "repo_root") {
    return trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  }
  return trimmed.toLowerCase();
}

function buildTitle(input: ActivityUpsertInput, kind: ActivityKind): string {
  const candidates = [
    input.currentFocus,
    input.objective,
    input.entityHints?.[0],
    input.attachmentNames?.[0],
    input.userMessage,
    input.summary,
  ];
  return compactText(candidates.find((candidate) => candidate?.trim()) ?? kind, 90);
}

function buildSummary(input: ActivityUpsertInput, previousSummary?: string): string {
  return compactText(uniqueStrings([
    previousSummary,
    input.progressSummary,
    input.summary,
    ...(input.completedMilestones ?? []),
  ]).join(" "), 900);
}

function buildAliases(input: ActivityUpsertInput, title: string): ActivityAlias[] {
  const values = uniqueStrings([
    title,
    ...(input.entityHints ?? []),
    ...(input.attachmentNames ?? []),
  ]).slice(0, 12);
  return values.map((value) => ({
    value: normalizeAlias(value),
    confidence: value === title ? 0.86 : 0.72,
    source: "inferred",
    lastSeenAt: input.createdAt,
  }));
}

function buildCues(
  input: ActivityUpsertInput,
  title: string,
  summary: string,
  state: ActivityState,
  assets: ActivityAssetRef[],
): ActivityCue[] {
  const at = input.createdAt;
  const cues: ActivityCue[] = [];
  addCue(cues, "goal", input.objective ?? state.objective ?? title, 92, "system", at);
  addCue(cues, "topic", title, 86, "system", at);
  addCue(cues, "action", input.progressSummary ?? input.summary, 82, "system", at);
  addCue(cues, "next_step", input.nextAction ?? state.nextStep, 86, "system", at);
  addCue(cues, "question", `continue ${title}`, 78, "inferred", at);
  addCue(cues, "question", `what is next for ${title}`, 72, "inferred", at);
  addCue(cues, "question", `what did we decide about ${title}`, 66, "inferred", at);
  for (const value of input.openWork ?? []) addCue(cues, "next_step", value, 78, "system", at);
  for (const value of input.blockers ?? []) addCue(cues, "blocker", value, 82, "system", at);
  for (const value of input.keyFacts ?? []) addCue(cues, "fact", value, 72, "system", at);
  for (const value of input.evidence ?? []) addCue(cues, "fact", value, 64, "system", at);
  for (const value of input.entityHints ?? []) addCue(cues, "keyword", value, 70, "inferred", at);
  for (const value of input.attachmentNames ?? []) addCue(cues, "asset", value, 76, "inferred", at);
  for (const asset of assets) {
    addCue(cues, "asset", assetLabel(asset), 82, "system", at);
    addCue(cues, "question", `where is ${assetLabel(asset)}`, 62, "inferred", at);
  }
  addCue(cues, "keyword", summary, 54, "system", at);
  return dedupeCues(cues).slice(0, 48);
}

function buildManualUpdateCues(input: {
  title: string;
  summary: string;
  openWork: string[];
  verifiedFacts: string[];
  nextStep: string | undefined;
  now: string;
}): ActivityCue[] {
  const cues: ActivityCue[] = [];
  addCue(cues, "topic", input.title, 80, "system", input.now);
  addCue(cues, "keyword", input.summary, 58, "system", input.now);
  addCue(cues, "next_step", input.nextStep, 82, "system", input.now);
  for (const value of input.openWork) addCue(cues, "next_step", value, 76, "system", input.now);
  for (const value of input.verifiedFacts) addCue(cues, "fact", value, 68, "system", input.now);
  return dedupeCues(cues).slice(0, 24);
}

function buildEntities(input: ActivityUpsertInput, kind: ActivityKind, assets: ActivityAssetRef[]): ActivityEntity[] {
  const at = input.createdAt;
  const entities: ActivityEntity[] = [];
  addEntity(entities, "activity_kind", kind, "context", 0.62, "system", at);
  for (const value of input.entityHints ?? []) addEntity(entities, "topic", value, "subject", 0.76, "inferred", at);
  for (const tool of input.toolsUsed ?? []) addEntity(entities, "tool", tool, "tool", 0.84, "system", at);
  for (const asset of assets) {
    if (asset.path) addEntity(entities, asset.kind === "directory" ? "directory" : "file", asset.path, "asset", 0.92, "asset", at);
    if (asset.displayName) addEntity(entities, asset.kind === "dataset" ? "dataset" : asset.kind === "document" ? "document" : "other", asset.displayName, "asset", 0.72, "asset", at);
    if (asset.documentId) addEntity(entities, "document", asset.documentId, "asset", 0.94, "asset", at);
    if (asset.fileId) addEntity(entities, "file", asset.fileId, "asset", 0.94, "asset", at);
    if (asset.directoryId) addEntity(entities, "directory", asset.directoryId, "asset", 0.94, "asset", at);
    if (asset.preparedInputId) addEntity(entities, "document", asset.preparedInputId, "source", 0.9, "asset", at);
    if (asset.uri) addEntity(entities, "url", asset.uri, "asset", 0.84, "asset", at);
  }
  return dedupeEntities(entities).slice(0, 48);
}

function collectAssets(input: ActivityUpsertInput): ActivityAssetRef[] {
  return (input.activityAssets ?? []).map((asset) => ({
    ...asset,
    lastUsedRunId: input.runId,
    lastUsedAt: input.createdAt,
  }));
}

function buildDiscussionRange(input: ActivityUpsertInput, isExistingActivity: boolean): ActivityDiscussionRange | null {
  if (!validSeq(input.discussionStartSeq) || !validSeq(input.discussionEndSeq)) {
    return null;
  }
  if (input.discussionStartSeq > input.discussionEndSeq) {
    return null;
  }
  return {
    sessionId: input.sessionId,
    startSeq: input.discussionStartSeq,
    endSeq: input.discussionEndSeq,
    reason: isExistingActivity ? "follow_up" : "initial_discussion",
  };
}

function mergeDiscussionRanges(
  existing: ActivityDiscussionRange[],
  next: ActivityDiscussionRange | null,
): ActivityDiscussionRange[] {
  const output = new Map<string, ActivityDiscussionRange>();
  for (const range of [...existing, ...(next ? [next] : [])]) {
    if (!validSeq(range.startSeq) || !validSeq(range.endSeq) || range.startSeq > range.endSeq) {
      continue;
    }
    const key = `${range.sessionId}:${range.startSeq}:${range.endSeq}:${range.reason}`;
    output.set(key, range);
  }
  return [...output.values()]
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.startSeq - b.startSeq || a.endSeq - b.endSeq)
    .slice(-20);
}

function buildState(input: ActivityUpsertInput, previous: ActivityState | undefined, assets: ActivityAssetRef[]): ActivityState {
  const objective = compactOptional(input.objective) ?? previous?.objective ?? previous?.goal;
  const summary = compactOptional(input.progressSummary ?? input.summary, 700) ?? previous?.summary;
  const evidence = compactList([
    ...(previous?.evidence ?? []),
    ...(input.evidence ?? []),
  ], 12, 220);
  const completedWork = compactList([
    ...(previous?.completedWork ?? []),
    ...(input.completedMilestones ?? []),
    ...(isDoneTask(input) && input.progressSummary ? [input.progressSummary] : []),
  ], 12, 220);
  const assetLabels = compactList([
    ...(previous?.assets ?? []),
    ...assets.map(assetLabel),
  ], 16, 220);
  const changedFiles = compactList([
    ...(previous?.changedFiles ?? []),
    ...assets.map((asset) => asset.path ?? asset.restore?.filePath).filter((path): path is string => Boolean(path)),
  ], 16, 220);
  const workingDirectories = compactList([
    ...(previous?.workingDirectories ?? []),
    ...assets.map((asset) => asset.restore?.directoryPath).filter((path): path is string => Boolean(path)),
  ], 10, 220);
  const lastVerification = compactOptional(input.evidence?.[0] ?? input.keyFacts?.[0] ?? previous?.lastVerification, 260);
  const userIntent = compactOptional(input.userMessage ?? input.objective ?? previous?.userIntent, 360);
  const lastAssistantResponse = compactOptional(input.assistantResponse ?? previous?.lastAssistantResponse, 360);
  const runHistory = appendStateRun(previous?.runHistory ?? [], buildStateRun(input));

  return {
    ...(objective ? { objective, goal: objective } : {}),
    status: deriveActivityStatus(input) ?? previous?.status ?? "open",
    ...(summary ? { summary } : {}),
    ...(userIntent ? { userIntent } : {}),
    assumptions: compactList([
      ...(previous?.assumptions ?? []),
      ...(input.assumptions ?? []),
    ], 8, 220),
    constraints: compactList([
      ...(previous?.constraints ?? []),
      ...(input.constraints ?? []),
    ], 8, 220),
    completedWork,
    openWork: compactList([...(input.openWork ?? []), ...(input.blockers ?? [])], 8, 220),
    blockers: compactList(input.blockers ?? [], 6, 220),
    ...(input.nextAction ? { nextStep: compactText(input.nextAction, 260) } : previous?.nextStep ? { nextStep: previous.nextStep } : {}),
    verifiedFacts: compactList([
      ...(previous?.verifiedFacts ?? []),
      ...(input.keyFacts ?? []),
      ...(input.evidence ?? []),
      ...(input.completedMilestones ?? []),
    ], 14, 220),
    evidence,
    assets: assetLabels,
    decisions: compactList(previous?.decisions ?? [], 8, 220),
    changedFiles,
    workingDirectories,
    ...(lastVerification ? { lastVerification } : {}),
    ...(lastAssistantResponse ? { lastAssistantResponse } : {}),
    runHistory,
  };
}

function buildRun(input: ActivityUpsertInput, assets: ActivityAssetRef[]): ActivityRunRef {
  return {
    runId: input.runId,
    sessionId: input.sessionId,
    runPath: input.runPath,
    ...(validSeq(input.triggerSeq) ? { triggerSeq: input.triggerSeq } : {}),
    ...(validSeq(input.discussionStartSeq) ? { discussionStartSeq: input.discussionStartSeq } : {}),
    ...(validSeq(input.discussionEndSeq) ? { discussionEndSeq: input.discussionEndSeq } : {}),
    status: input.status,
    ...(input.taskStatus ? { taskStatus: input.taskStatus } : {}),
    ...(input.userMessage ? { userMessage: compactText(input.userMessage, 260) } : {}),
    ...(input.assistantResponse ? { assistantResponse: compactText(input.assistantResponse, 360) } : {}),
    summary: compactText(input.progressSummary || input.summary, 420),
    toolsUsed: uniqueStrings(input.toolsUsed ?? []).slice(0, 12),
    assetIds: uniqueStrings(assets.map((asset) => asset.assetId)).slice(0, 20),
    createdAt: input.createdAt,
  };
}

function buildStateRun(input: ActivityUpsertInput): ActivityStateRunSummary {
  return {
    runId: input.runId,
    status: input.status,
    ...(input.taskStatus ? { taskStatus: input.taskStatus } : {}),
    summary: compactText(input.progressSummary || input.summary, 260),
    toolsUsed: uniqueStrings(input.toolsUsed ?? []).slice(0, 8),
    createdAt: input.createdAt,
  };
}

function appendStateRun(runs: ActivityStateRunSummary[], run: ActivityStateRunSummary): ActivityStateRunSummary[] {
  return [...runs.filter((item) => item.runId !== run.runId), run].slice(-10);
}

function deriveActivityStatus(input: ActivityUpsertInput): ActivityStatus | undefined {
  if (input.userInputNeeded?.trim() || input.taskStatus === "needs_user_input") return "needs_user";
  if (input.taskStatus === "blocked" || input.status === "failed" || input.status === "stuck") return "blocked";
  if (input.taskStatus === "done" || input.taskStatus === "likely_done") return "done";
  if ((input.openWork?.length ?? 0) > 0 || (input.blockers?.length ?? 0) > 0) return "open";
  if ((input.toolsUsed?.length ?? 0) > 0) return "done";
  return undefined;
}

function isDoneTask(input: ActivityUpsertInput): boolean {
  return input.taskStatus === "done" || input.taskStatus === "likely_done";
}

function assetLabel(asset: ActivityAssetRef): string {
  return asset.path
    ?? asset.displayName
    ?? asset.uri
    ?? asset.documentId
    ?? asset.fileId
    ?? asset.directoryId
    ?? asset.preparedInputId
    ?? asset.assetId;
}

function appendRun(runs: ActivityRunRef[], run: ActivityRunRef): ActivityRunRef[] {
  return [...runs.filter((item) => item.runId !== run.runId), run].slice(-20);
}

function mergeIdentities(left: ActivityIdentity[], right: ActivityIdentity[], seenAt: string): ActivityIdentity[] {
  return dedupeIdentities([...left, ...right]).map((identity) => ({
    ...identity,
    lastSeenAt: right.some((candidate) => candidate.type === identity.type && candidate.value === identity.value) ? seenAt : identity.lastSeenAt,
  })).slice(0, 32);
}

function dedupeIdentities(values: ActivityIdentity[]): ActivityIdentity[] {
  const output = new Map<string, ActivityIdentity>();
  for (const identity of values) {
    const normalized = normalizeIdentityValue(identity.type, identity.value);
    if (!normalized) continue;
    const key = `${identity.type}:${normalized}`;
    const previous = output.get(key);
    output.set(key, previous && previous.confidence > identity.confidence ? previous : {
      ...identity,
      value: normalized,
    });
  }
  return [...output.values()];
}

function mergeAliases(left: ActivityAlias[], right: ActivityAlias[], seenAt: string): ActivityAlias[] {
  const output = new Map<string, ActivityAlias>();
  for (const alias of [...left, ...right]) {
    const value = normalizeAlias(alias.value);
    if (!value) continue;
    const previous = output.get(value);
    output.set(value, previous ? {
      ...previous,
      confidence: Math.max(previous.confidence, alias.confidence),
      lastSeenAt: right.some((candidate) => normalizeAlias(candidate.value) === value) ? seenAt : previous.lastSeenAt,
    } : { ...alias, value });
  }
  return [...output.values()].slice(0, 20);
}

function mergeCues(left: ActivityCue[], right: ActivityCue[], seenAt: string): ActivityCue[] {
  const output = new Map<string, ActivityCue>();
  for (const cue of [...left, ...right]) {
    const normalizedText = normalizeCue(cue.text);
    if (!normalizedText) continue;
    const key = `${cue.cueType}:${normalizedText}`;
    const previous = output.get(key);
    output.set(key, previous ? {
      ...previous,
      text: cue.text,
      weight: Math.max(previous.weight, cue.weight),
      lastSeenAt: right.some((candidate) => candidate.cueType === cue.cueType && normalizeCue(candidate.text) === normalizedText)
        ? seenAt
        : previous.lastSeenAt,
    } : { ...cue, normalizedText });
  }
  return [...output.values()]
    .sort((a, b) => b.weight - a.weight || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, 72);
}

function mergeEntities(left: ActivityEntity[], right: ActivityEntity[], seenAt: string): ActivityEntity[] {
  const output = new Map<string, ActivityEntity>();
  for (const entity of [...left, ...right]) {
    const normalizedName = normalizeEntityName(entity.name);
    if (!normalizedName) continue;
    const key = `${entity.entityType}:${normalizedName}:${entity.role}`;
    const previous = output.get(key);
    output.set(key, previous ? {
      ...previous,
      name: entity.name,
      confidence: Math.max(previous.confidence, entity.confidence),
      lastSeenAt: right.some((candidate) => (
        candidate.entityType === entity.entityType
        && normalizeEntityName(candidate.name) === normalizedName
        && candidate.role === entity.role
      )) ? seenAt : previous.lastSeenAt,
    } : { ...entity, normalizedName });
  }
  return [...output.values()]
    .sort((a, b) => b.confidence - a.confidence || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, 72);
}

function mergeAssets(left: ActivityAssetRef[], right: ActivityAssetRef[]): ActivityAssetRef[] {
  const output = new Map<string, ActivityAssetRef>();
  for (const asset of [...left, ...right]) {
    const key = asset.assetId || asset.fileId || asset.directoryId || asset.documentId || asset.path || asset.displayName;
    if (!key) continue;
    const previous = output.get(key);
    output.set(key, previous ? {
      ...previous,
      ...asset,
      sourceRunId: previous.sourceRunId,
      sourceRunPath: previous.sourceRunPath,
      metadata: {
        ...(previous.metadata ?? {}),
        ...(asset.metadata ?? {}),
      },
    } : asset);
  }
  return [...output.values()];
}

function rowToAsset(row: AssetRow): ActivityAssetRef {
  return {
    assetId: row.asset_id,
    kind: row.kind,
    origin: row.origin,
    role: row.role,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    ...(row.path ? { path: row.path } : {}),
    ...(row.uri ? { uri: row.uri } : {}),
    ...(row.document_id ? { documentId: row.document_id } : {}),
    ...(row.file_id ? { fileId: row.file_id } : {}),
    ...(row.directory_id ? { directoryId: row.directory_id } : {}),
    ...(row.prepared_input_id ? { preparedInputId: row.prepared_input_id } : {}),
    ...(parseJsonMaybe(row.manifest_json) ? { manifest: parseJsonMaybe(row.manifest_json) as ActivityAssetRef["manifest"] } : {}),
    ...(parseJsonMaybe(row.summary_json) ? { summary: parseJsonMaybe(row.summary_json) as ActivityAssetRef["summary"] } : {}),
    ...(parseJsonMaybe(row.detail_json) ? { detail: parseJsonMaybe(row.detail_json) as ActivityAssetRef["detail"] } : {}),
    ...(parseJsonMaybe(row.restore_json) ? { restore: parseJsonMaybe(row.restore_json) as ActivityAssetRef["restore"] } : {}),
    sourceRunId: row.source_run_id,
    sourceRunPath: row.source_run_path,
    lastUsedRunId: row.last_used_run_id,
    lastUsedAt: row.last_used_at,
    ...(parseJsonMaybe(row.metadata_json) ? { metadata: parseJsonMaybe(row.metadata_json) as Record<string, unknown> } : {}),
  };
}

function rowToRun(row: RunRow): ActivityRunRef {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    runPath: row.run_path,
    ...(typeof row.trigger_seq === "number" ? { triggerSeq: row.trigger_seq } : {}),
    ...(typeof row.discussion_start_seq === "number" ? { discussionStartSeq: row.discussion_start_seq } : {}),
    ...(typeof row.discussion_end_seq === "number" ? { discussionEndSeq: row.discussion_end_seq } : {}),
    status: row.status,
    ...(row.task_status ? { taskStatus: row.task_status } : {}),
    ...(row.user_message ? { userMessage: row.user_message } : {}),
    ...(row.assistant_response ? { assistantResponse: row.assistant_response } : {}),
    summary: row.summary,
    toolsUsed: parseJsonArray<string>(row.tools_used_json),
    assetIds: parseJsonArray<string>(row.asset_ids_json),
    createdAt: row.created_at,
  };
}

function initialConfidence(input: ActivityUpsertInput): number {
  if ((input.activityAssets?.length ?? 0) > 0) return 0.86;
  if ((input.openWork?.length ?? 0) > 0) return 0.78;
  if ((input.keyFacts?.length ?? 0) > 0) return 0.72;
  return 0.62;
}

function stableActivityId(clientId: string, sessionId: string, title: string, kind: ActivityKind): string {
  const hash = createHash("sha256")
    .update(`${clientId}:${sessionId}:${kind}:${normalizeAlias(title)}`)
    .digest("hex")
    .slice(0, 20);
  return `activity_${hash}`;
}

function addIdentity(
  identities: ActivityIdentity[],
  type: ActivityIdentityType,
  value: string | undefined,
  confidence: number,
  source: ActivityIdentity["source"],
  lastSeenAt: string,
): void {
  const normalized = normalizeIdentityValue(type, value);
  if (!normalized) return;
  identities.push({ type, value: normalized, confidence, source, lastSeenAt });
}

function addCue(
  cues: ActivityCue[],
  cueType: ActivityCueType,
  text: string | undefined,
  weight: number,
  source: ActivityCue["source"],
  lastSeenAt: string,
): void {
  const normalizedText = normalizeCue(text ?? "");
  if (!normalizedText) return;
  cues.push({
    cueType,
    text: compactText(text ?? "", 220),
    normalizedText,
    weight: Math.max(0, Math.min(100, Math.round(weight))),
    source,
    lastSeenAt,
  });
}

function addEntity(
  entities: ActivityEntity[],
  entityType: ActivityEntityType,
  name: string | undefined,
  role: ActivityEntity["role"],
  confidence: number,
  source: ActivityEntity["source"],
  lastSeenAt: string,
): void {
  const normalizedName = normalizeEntityName(name ?? "");
  if (!normalizedName) return;
  entities.push({
    entityType,
    name: compactText(name ?? "", 180),
    normalizedName,
    role,
    confidence: Math.max(0, Math.min(1, confidence)),
    source,
    lastSeenAt,
  });
}

function dedupeCues(values: ActivityCue[]): ActivityCue[] {
  const output = new Map<string, ActivityCue>();
  for (const cue of values) {
    const normalizedText = normalizeCue(cue.text);
    if (!normalizedText) continue;
    const key = `${cue.cueType}:${normalizedText}`;
    const previous = output.get(key);
    output.set(key, previous && previous.weight > cue.weight ? previous : { ...cue, normalizedText });
  }
  return [...output.values()];
}

function dedupeEntities(values: ActivityEntity[]): ActivityEntity[] {
  const output = new Map<string, ActivityEntity>();
  for (const entity of values) {
    const normalizedName = normalizeEntityName(entity.name);
    if (!normalizedName) continue;
    const key = `${entity.entityType}:${normalizedName}:${entity.role}`;
    const previous = output.get(key);
    output.set(key, previous && previous.confidence > entity.confidence ? previous : { ...entity, normalizedName });
  }
  return [...output.values()];
}

function normalizeAlias(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeCue(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[_/.-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEntityName(value: string): string {
  return normalizeCue(value);
}

function searchableText(activity: ActivityThread): string {
  return [
    activity.kind,
    activity.title,
    activity.summary,
    activity.state.objective,
    activity.state.goal,
    activity.state.status,
    activity.state.summary,
    activity.state.userIntent,
    activity.state.nextStep,
    ...activity.state.assumptions,
    ...activity.state.constraints,
    ...activity.state.completedWork,
    ...activity.state.openWork,
    ...activity.state.blockers,
    ...activity.state.verifiedFacts,
    ...activity.state.evidence,
    ...activity.state.assets,
    ...activity.state.decisions,
    ...activity.state.changedFiles,
    ...activity.state.workingDirectories,
    ...activity.cues.map((cue) => cue.text),
    ...activity.entities.flatMap((entity) => [entity.entityType, entity.name]),
    ...activity.aliases.map((alias) => alias.value),
    ...activity.identities.map((identity) => identity.value),
    ...activity.assets.flatMap((asset) => [
      asset.displayName,
      asset.path,
      asset.uri,
      asset.documentId,
      asset.fileId,
      asset.directoryId,
      asset.preparedInputId,
      asset.origin,
      asset.role,
    ]),
    ...activity.state.runHistory.map((run) => run.summary),
    ...activity.runs.map((run) => run.summary),
  ].filter(Boolean).join("\n").toLowerCase();
}

function activityStateSearchText(activity: ActivityThread): string {
  return [
    activity.state.objective,
    activity.state.goal,
    activity.state.status,
    activity.state.summary,
    activity.state.userIntent,
    activity.state.nextStep,
    ...activity.state.assumptions,
    ...activity.state.constraints,
    ...activity.state.completedWork,
    ...activity.state.openWork,
    ...activity.state.blockers,
    ...activity.state.verifiedFacts,
    ...activity.state.evidence,
    ...activity.state.decisions,
    ...activity.state.changedFiles,
    ...activity.state.workingDirectories,
    ...activity.state.runHistory.map((run) => run.summary),
  ].filter(Boolean).join("\n");
}

function recencySearchBoost(activity: ActivityThread, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(activity.lastTouchedAt)) / 86_400_000);
  if (activity.state.openWork.length > 0 && ageDays <= 14) return 0.5;
  if (ageDays <= 1) return 0.35;
  if (ageDays <= 7) return 0.2;
  return 0;
}

function tokenOverlapScore(terms: string[], haystack: string): number {
  const uniqueTerms = [...new Set(terms)];
  if (uniqueTerms.length === 0) return 0;
  const matched = uniqueTerms.filter((term) => haystack.includes(term)).length;
  return matched / uniqueTerms.length;
}

function toFtsQuery(value: string): string {
  const terms = value.toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  return [...new Set(terms)]
    .map((term) => `${term.replace(/"/g, "")}*`)
    .join(" OR ");
}

function tokenize(value: string): string[] {
  return value.toLowerCase()
    .split(/[^a-z0-9_.\/-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 24);
}

function extractPathLikeValues(text: string): string[] {
  const matches = text.match(/(?:[./~\w-]+\/[\w./~-]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|html|css|txt|csv|pdf|docx|xlsx|py|sql))/gi) ?? [];
  return uniqueStrings(matches.map((value) => value.replace(/[),.;:]+$/g, ""))).slice(0, 24);
}

function compactList(values: string[], count: number, chars: number): string[] {
  return uniqueStrings(values)
    .map((value) => compactText(value, chars))
    .filter(Boolean)
    .slice(0, count);
}

function compactText(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactOptional(value: string | undefined, maxChars = 260): string | undefined {
  const compact = value?.replace(/\s+/g, " ").trim() ?? "";
  return compact ? compactText(compact, maxChars) : undefined;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const compact = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!compact) continue;
    const key = compact.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(compact);
  }
  return output;
}

function normalizeState(value: Record<string, unknown>): ActivityState {
  return {
    ...(typeof value["objective"] === "string" ? { objective: value["objective"] } : {}),
    ...(typeof value["goal"] === "string" ? { goal: value["goal"] } : {}),
    ...(readActivityStatus(value["status"]) ? { status: readActivityStatus(value["status"]) } : {}),
    ...(typeof value["summary"] === "string" ? { summary: value["summary"] } : {}),
    ...(typeof value["userIntent"] === "string" ? { userIntent: value["userIntent"] } : {}),
    assumptions: readStringArray(value["assumptions"]),
    constraints: readStringArray(value["constraints"]),
    completedWork: readStringArray(value["completedWork"]),
    openWork: readStringArray(value["openWork"]),
    blockers: readStringArray(value["blockers"]),
    ...(typeof value["nextStep"] === "string" ? { nextStep: value["nextStep"] } : {}),
    verifiedFacts: readStringArray(value["verifiedFacts"]),
    evidence: readStringArray(value["evidence"]),
    assets: readStringArray(value["assets"]),
    decisions: readStringArray(value["decisions"]),
    changedFiles: readStringArray(value["changedFiles"]),
    workingDirectories: readStringArray(value["workingDirectories"]),
    ...(typeof value["lastVerification"] === "string" ? { lastVerification: value["lastVerification"] } : {}),
    ...(typeof value["lastAssistantResponse"] === "string" ? { lastAssistantResponse: value["lastAssistantResponse"] } : {}),
    runHistory: readRunHistory(value["runHistory"]),
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readActivityStatus(value: unknown): ActivityStatus | undefined {
  return value === "open" || value === "done" || value === "blocked" || value === "needs_user" || value === "archived"
    ? value
    : undefined;
}

function readRunHistory(value: unknown): ActivityStateRunSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ActivityStateRunSummary[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    if (typeof record["runId"] !== "string" || typeof record["summary"] !== "string" || typeof record["createdAt"] !== "string") {
      return [];
    }
    const status = record["status"];
    if (status !== "completed" && status !== "failed" && status !== "stuck") {
      return [];
    }
    return [{
      runId: record["runId"],
      status,
      ...(typeof record["taskStatus"] === "string" ? { taskStatus: record["taskStatus"] } : {}),
      summary: record["summary"],
      toolsUsed: readStringArray(record["toolsUsed"]),
      createdAt: record["createdAt"],
    }];
  });
}

function readDiscussionRanges(value: unknown): ActivityDiscussionRange[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ActivityDiscussionRange[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const sessionId = typeof record["sessionId"] === "string" ? record["sessionId"].trim() : "";
    const startSeq = readSeq(record["startSeq"]);
    const endSeq = readSeq(record["endSeq"]);
    const reason = record["reason"];
    if (!sessionId || startSeq === undefined || endSeq === undefined || startSeq > endSeq) {
      return [];
    }
    return [{
      sessionId,
      startSeq,
      endSeq,
      reason: reason === "follow_up" || reason === "clarification" || reason === "confirmation"
        ? reason
        : "initial_discussion",
    }];
  });
}

function readSeq(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function validSeq(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJsonMaybe(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray<T>(value: string): T[] {
  const parsed = parseJsonMaybe(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function parseJsonMaybe(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}
