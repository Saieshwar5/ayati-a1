import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataRoot = resolve(root, "ayati-main", "data");
const options = parseArgs(process.argv.slice(2));
const inputPath = options.input
  ? resolve(root, options.input)
  : await latestFeedbackPath();
const primaryEvents = parseEvents(await readFile(inputPath, "utf8"));
const correlatedEvents = await readCorrelatedTransportEvents(inputPath, primaryEvents);
const events = [...primaryEvents, ...correlatedEvents]
  .sort((left, right) => Number(left.tsMs ?? 0) - Number(right.tsMs ?? 0));

function parseEvents(content) {
  return content
  .split("\n")
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      return { ts: "unknown", stage: "report", event: "invalid_json", data: { line: index + 1 } };
    }
  });
}

const report = renderReport(inputPath, events);
if (options.output) await writeFile(resolve(root, options.output), report, "utf8");
process.stdout.write(report);

async function latestFeedbackPath() {
  const sessionPointer = resolve(dataRoot, "feedback", "latest-session.json");
  const latest = JSON.parse(await readFile(sessionPointer, "utf8"));
  if (typeof latest.path !== "string") throw new Error("latest session feedback pointer has no path");
  return isAbsolute(latest.path) ? latest.path : resolve(dataRoot, latest.path);
}

async function readCorrelatedTransportEvents(path, primary) {
  if (basename(path) === "session-unknown-session.jsonl") return [];
  const traceIds = new Set(primary.map(traceIdOf).filter(Boolean));
  if (traceIds.size === 0) return [];
  const processPath = resolve(dirname(path), "session-unknown-session.jsonl");
  const content = await readFile(processPath, "utf8").catch(() => "");
  return parseEvents(content).filter((event) => traceIds.has(traceIdOf(event)));
}

function traceIdOf(event) {
  const value = event.traceId ?? event.data?.traceId;
  return typeof value === "string" && value ? value : undefined;
}

function renderReport(path, input) {
  const contextEvents = input.filter((event) =>
    event.stage === "context_engine" || event.stage === "git_context_service");
  const counts = countBy(contextEvents, (event) => event.event);
  const lifecycles = buildWorkstreamLifecycles(contextEvents);
  const findings = validate(contextEvents, lifecycles);
  const rows = contextEvents.map((event) => {
    const data = event.data ?? {};
    return [
      shortTime(event.ts),
      data.component ?? event.stage,
      event.event,
      event.runId ?? "-",
      data.workstreamId ?? event.workstreamId ?? "-",
      data.step ?? "-",
      data.outcome ?? "-",
      data.durationMs ?? "-",
      data.contextRevision ?? data.revision ?? "-",
    ].map(cell).join(" | ");
  });
  return [
    "# Git Context live-test report",
    "",
    `Input: ${path}`,
    `Correlated transport events: ${correlatedEvents.length}`,
    "",
    "## Health",
    "",
    findings.length === 0
      ? "PASS — no deterministic lifecycle or outcome findings."
      : `FAIL — ${findings.length} lifecycle/outcome finding(s).`,
    "",
    ...findings.map((finding) => `- ${finding}`),
    ...(findings.length === 0 ? [] : [""]),
    "## Counts",
    "",
    `- Context events: ${contextEvents.length}`,
    `- Cache hits: ${sum(counts, ["harness_context_cache_hit", "active_context_cache_hit"])}`,
    `- Cache misses: ${sum(counts, ["harness_context_cache_miss", "active_context_cache_miss"])}`,
    `- Cache refreshes/builds: ${sum(counts, ["harness_context_refresh_completed", "active_context_built"])}`,
    `- Incremental context updates: ${counts.get("harness_context_incrementally_updated") ?? 0}`,
    `- Persisted steps: ${sum(counts, ["run_step_persisted", "run_step_persistence_acknowledged"])}`,
    `- HTTP request failures: ${counts.get("http_request_failed") ?? 0}`,
    `- Workstream selections: ${lifecycles.length}`,
    `- New-workstream selections: ${lifecycles.filter((item) => item.workstreamCreated === true).length}`,
    `- Continued requests: ${lifecycles.filter((item) => item.requestDecision === "continue").length}`,
    `- New requests: ${lifecycles.filter((item) => item.requestDecision === "create").length}`,
    `- Workstream-bound runs: ${counts.get("run_workstream_bound") ?? 0}`,
    `- Verified resource mutations: ${counts.get("resource_mutation_verified") ?? 0}`,
    `- Run finalizations: ${counts.get("run_finalization_completed") ?? 0}`,
    `- Workstream context commits created: ${sum(counts, ["workstream_commit_created", "workstream_context_commit_created"])}`,
    `- Child restarts: ${counts.get("child_restart_completed") ?? 0}`,
    "",
    "## Workstream lifecycle",
    "",
    "Workstream | Run | Selection | Request decision | Request | Context repository | Finalization | Commit",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...(lifecycles.length === 0
      ? ["- | - | - | - | - | - | - | -"]
      : lifecycles.map((item) => [
        item.workstreamId ?? "-",
        item.runId ?? "-",
        item.selectionMode ?? "-",
        item.requestDecision ?? "-",
        formatRequest(item),
        item.contextRepositoryPath ?? "-",
        formatFinalization(item),
        formatCommit(item),
      ].map(cell).join(" | "))),
    "",
    "## Timeline",
    "",
    "Time | Component | Event | Run | Workstream | Step | Outcome | ms | Revision",
    "--- | --- | --- | --- | --- | ---: | --- | ---: | ---",
    ...rows,
    "",
  ].join("\n");
}

function validate(events, lifecycles) {
  const findings = [];
  for (const event of events) {
    if (["harness_context_refresh_failed", "run_step_persistence_failed", "child_restart_failed", "startup_recovery_failed"].includes(event.event)) {
      findings.push(`${event.event} at ${event.ts}${event.runId ? ` for ${event.runId}` : ""}`);
    }
    if (event.event === "http_request_failed") {
      findings.push(`HTTP ${event.data?.operation ?? "request"} failed with ${event.data?.errorCode ?? "unknown error"} at ${event.ts}`);
    }
  }
  pair(events, "run_step_persistence_queued", "run_step_persistence_acknowledged", (event) => `${event.runId}:${event.data?.step}`, findings);
  pair(events, "run_finalization_started", "run_finalization_completed", (event) => event.runId, findings, new Set(["run_finalization_failed"]));
  pair(
    events,
    "resource_mutation_prepared",
    "resource_mutation_verified",
    (event) => event.data?.operationId,
    findings,
  );
  for (const lifecycle of lifecycles) {
    const identity = lifecycle.workstreamId ?? lifecycle.runId ?? "unknown workstream";
    if (!lifecycle.contextRepositoryPath) {
      findings.push(`workstream selection has no context repository: ${identity}`);
    }
    if (!lifecycle.requestDecision) {
      findings.push(`workstream selection has no explicit request decision: ${identity}`);
    }
    if (!lifecycle.requestId) {
      findings.push(`workstream selection has no request identity: ${identity}`);
    }
    if (["initial", "create"].includes(lifecycle.requestDecision)
      && lifecycle.requestCreated !== true) {
      findings.push(`${lifecycle.requestDecision} selection did not create its request: ${identity}`);
    }
    if (lifecycle.requestDecision === "continue" && lifecycle.requestCreated !== false) {
      findings.push(`continue selection does not prove request reuse: ${identity}`);
    }
    if (lifecycle.finalizationStatus === "committed" && lifecycle.commitCreated === undefined) {
      findings.push(`workstream finalization has no commit-created result: ${identity}`);
    }
    if (lifecycle.finalizationStatus === "committed" && !lifecycle.headAfter) {
      findings.push(`workstream finalization has no final context HEAD: ${identity}`);
    }
    if (lifecycle.commitCreated === true && !lifecycle.commit) {
      findings.push(`workstream finalization created a context commit without its identity: ${identity}`);
    }
    if (lifecycle.commit && lifecycle.headAfter && lifecycle.commit !== lifecycle.headAfter) {
      findings.push(`workstream finalization commit does not match context HEAD: ${identity}`);
    }
    if (lifecycle.validation === "failed") {
      findings.push(`workstream finalization validation failed: ${identity}`);
    }
    if (lifecycle.outcome && lifecycle.outcome !== "done") {
      findings.push(`workstream outcome is ${lifecycle.outcome}: ${identity}`);
    }
  }
  return [...new Set(findings)];
}

function buildWorkstreamLifecycles(events) {
  const records = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    const nested = data.workstreamLifecycle ?? data.contextEngine?.workstreamLifecycle ?? {};
    const repository = nested.repository ?? {};
    const request = nested.request ?? {};
    const run = nested.run ?? {};
    const finalization = nested.finalization ?? {};
    const binding = data.workstreamBinding ?? {};
    const commitResult = data.workstreamContextCommit ?? {};
    const workstreamId = event.workstreamId
      ?? data.workstreamId
      ?? binding.workstreamId
      ?? repository.workstreamId
      ?? commitResult.workstreamId;
    const runId = event.runId ?? data.runId ?? run.runId;
    if (!workstreamId && !runId) continue;
    if (!isWorkstreamLifecycleEvent(event.event, nested)) continue;
    const key = workstreamId
      ? `workstream:${workstreamId}:run:${runId ?? "-"}`
      : `run:${runId}`;
    const current = records.get(key) ?? {};
    records.set(key, mergeDefined(current, {
      workstreamId,
      runId,
      contextRepositoryPath: data.contextRepositoryPath ?? repository.contextRepositoryPath,
      selectionMode: data.mode ?? repository.selectionMode,
      workstreamCreated: data.workstreamCreated ?? repository.workstreamCreated,
      requestDecision: data.requestDecision ?? request.decision,
      requestId: data.requestId ?? binding.requestId ?? request.requestId ?? commitResult.requestId,
      requestStatus: data.requestStatus ?? request.status,
      requestCreated: data.requestCreated ?? request.created,
      finalizationStatus: finalization.status
        ?? (event.event === "run_finalization_started" ? "started" : undefined)
        ?? (event.event === "run_finalization_completed" ? commitResult.status : undefined)
        ?? (event.event === "run_finalization_failed" ? "failed" : undefined),
      outcome: data.outcome ?? data.requestedOutcome ?? finalization.outcome,
      validation: data.validation ?? finalization.validation,
      commit: commitResult.commit ?? finalization.commit,
      commitCreated: (commitResult.status === "committed" ? true : undefined)
        ?? finalization.commitCreated,
      headAfter: commitResult.headAfter ?? repository.headAfter ?? finalization.headAfter,
    }));
  }
  return [...records.values()]
    .filter((item) => item.workstreamId)
    .sort((left, right) => String(left.workstreamId ?? left.runId)
      .localeCompare(String(right.workstreamId ?? right.runId)));
}

function isWorkstreamLifecycleEvent(name, nested) {
  return [
    "run_workstream_bound",
    "agent_routed",
    "run_finalization_started",
    "run_finalization_completed",
    "run_finalization_failed",
    "workstream_commit_created",
    "workstream_context_commit_created",
  ].includes(name) || Boolean(nested.repository);
}

function mergeDefined(current, update) {
  const result = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined && value !== null && value !== "") result[key] = value;
  }
  return result;
}

function formatRequest(item) {
  if (!item.requestId) return "-";
  return item.requestStatus ? `${item.requestId} (${item.requestStatus})` : item.requestId;
}

function formatFinalization(item) {
  const status = item.finalizationStatus ?? "not observed";
  const details = [item.outcome, item.validation].filter(Boolean);
  return details.length > 0 ? `${status} (${details.join(", ")})` : status;
}

function shortCommit(value) {
  return typeof value === "string" && value ? value.slice(0, 12) : "-";
}

function formatCommit(item) {
  if (item.commitCreated === false) return `none (HEAD ${shortCommit(item.headAfter ?? item.commit)})`;
  return shortCommit(item.commit ?? item.headAfter);
}

function pair(events, startedName, completedName, keyOf, findings, alternativeNames = new Set()) {
  const completed = new Set(events
    .filter((event) => event.event === completedName || alternativeNames.has(event.event))
    .map(keyOf)
    .filter(Boolean));
  for (const started of events.filter((event) => event.event === startedName)) {
    const key = keyOf(started);
    if (key && !completed.has(key)) findings.push(`${startedName} has no ${completedName} for ${key}`);
  }
}

function countBy(items, keyOf) {
  const result = new Map();
  for (const item of items) {
    const key = keyOf(item);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function sum(counts, keys) {
  return keys.reduce((total, key) => total + (counts.get(key) ?? 0), 0);
}

function shortTime(value) {
  return typeof value === "string" && value.includes("T") ? value.slice(11, 23) : String(value ?? "-");
}

function cell(value) {
  return String(value ?? "-").replaceAll("|", "\\|").replaceAll("\n", " ");
}

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--input") result.input = args[++index];
    else if (args[index] === "--output") result.output = args[++index];
  }
  return result;
}
