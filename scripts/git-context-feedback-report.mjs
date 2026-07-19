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
  const lifecycles = buildTaskLifecycles(contextEvents);
  const findings = validate(contextEvents, lifecycles);
  const rows = contextEvents.map((event) => {
    const data = event.data ?? {};
    return [
      shortTime(event.ts),
      data.component ?? event.stage,
      event.event,
      event.runId ?? "-",
      data.taskId ?? "-",
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
    `- Task selections: ${lifecycles.length}`,
    `- New-task selections: ${lifecycles.filter((item) => item.taskCreated === true).length}`,
    `- Continued requests: ${lifecycles.filter((item) => item.requestDecision === "continue").length}`,
    `- New requests: ${lifecycles.filter((item) => item.requestDecision === "create").length}`,
    `- Task-bound runs: ${counts.get("run_task_bound") ?? 0}`,
    `- Verified task mutations staged: ${counts.get("task_mutation_staged") ?? 0}`,
    `- Run finalizations: ${counts.get("run_finalization_completed") ?? 0}`,
    `- Task commits created: ${counts.get("task_commit_created") ?? 0}`,
    `- Child restarts: ${counts.get("child_restart_completed") ?? 0}`,
    "",
    "## Task lifecycle",
    "",
    "Task | Run | Selection | Request decision | Request | Working directory | Finalization | Commit",
    "--- | --- | --- | --- | --- | --- | --- | ---",
    ...(lifecycles.length === 0
      ? ["- | - | - | - | - | - | - | -"]
      : lifecycles.map((item) => [
        item.taskId ?? "-",
        item.runId ?? "-",
        item.selectionMode ?? "-",
        item.requestDecision ?? "-",
        formatRequest(item),
        item.workingDirectory ?? "-",
        formatFinalization(item),
        formatCommit(item),
      ].map(cell).join(" | "))),
    "",
    "## Timeline",
    "",
    "Time | Component | Event | Run | Task | Step | Outcome | ms | Revision",
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
  pair(events, "mutation_authority_acquired", "mutation_verified", (event) => event.data?.authorityId, findings);
  const verifiedMutations = events.filter((event) =>
    event.event === "mutation_verified" && event.data?.verified === true);
  const stagedMutations = new Set(events
    .filter((event) => event.event === "task_mutation_staged")
    .map((event) => event.data?.authorityId)
    .filter(Boolean));
  for (const verified of verifiedMutations) {
    const authorityId = verified.data?.authorityId;
    if (authorityId && !stagedMutations.has(authorityId)) {
      findings.push(`verified mutation was not staged for task-bound finalization: ${authorityId}`);
    }
  }
  for (const lifecycle of lifecycles) {
    const identity = lifecycle.taskId ?? lifecycle.runId ?? "unknown task";
    if (!lifecycle.workingDirectory) {
      findings.push(`task selection has no stable working directory: ${identity}`);
    }
    if (!lifecycle.requestDecision) {
      findings.push(`task selection has no explicit request decision: ${identity}`);
    }
    if (!lifecycle.requestId) {
      findings.push(`task selection has no request identity: ${identity}`);
    }
    if (["initial", "create"].includes(lifecycle.requestDecision)
      && lifecycle.requestCreated !== true) {
      findings.push(`${lifecycle.requestDecision} selection did not create its request: ${identity}`);
    }
    if (lifecycle.requestDecision === "continue" && lifecycle.requestCreated !== false) {
      findings.push(`continue selection does not prove request reuse: ${identity}`);
    }
    if (lifecycle.finalizationStatus === "committed" && lifecycle.commitCreated === undefined) {
      findings.push(`task finalization has no commit-created result: ${identity}`);
    }
    if (lifecycle.finalizationStatus === "committed" && !lifecycle.headAfter) {
      findings.push(`task finalization has no final task HEAD: ${identity}`);
    }
    if (lifecycle.commitCreated === true && !lifecycle.commit) {
      findings.push(`task finalization created a commit without its identity: ${identity}`);
    }
    if (lifecycle.commit && lifecycle.headAfter && lifecycle.commit !== lifecycle.headAfter) {
      findings.push(`task finalization commit does not match task HEAD: ${identity}`);
    }
    if (lifecycle.validation === "failed") {
      findings.push(`task finalization validation failed: ${identity}`);
    }
    if (lifecycle.outcome && lifecycle.outcome !== "done") {
      findings.push(`task outcome is ${lifecycle.outcome}: ${identity}`);
    }
  }
  return [...new Set(findings)];
}

function buildTaskLifecycles(events) {
  const records = new Map();
  for (const event of events) {
    const data = event.data ?? {};
    const nested = data.taskLifecycle ?? data.contextEngine?.taskLifecycle ?? {};
    const repository = nested.repository ?? {};
    const request = nested.request ?? {};
    const run = nested.run ?? {};
    const finalization = nested.finalization ?? {};
    const commitResult = data.commit ?? {};
    const taskId = event.taskId ?? data.taskId ?? repository.taskId ?? commitResult.taskId;
    const runId = event.runId ?? data.runId ?? run.runId;
    if (!taskId && !runId) continue;
    if (!isTaskLifecycleEvent(event.event, data, nested)) continue;
    const key = taskId ? `task:${taskId}:run:${runId ?? "-"}` : `run:${runId}`;
    const current = records.get(key) ?? {};
    records.set(key, mergeDefined(current, {
      taskId,
      runId,
      workingDirectory: data.workingDirectory ?? repository.workingDirectory,
      selectionMode: data.mode ?? repository.selectionMode,
      taskCreated: data.taskCreated ?? repository.taskCreated,
      requestDecision: data.taskRequestDecision ?? request.decision,
      requestId: data.taskRequestId ?? request.requestId,
      requestStatus: data.taskRequestStatus ?? request.status,
      requestCreated: data.taskRequestCreated ?? request.created,
      finalizationStatus: finalization.status
        ?? (event.event === "run_finalization_started" ? "started" : undefined)
        ?? (event.event === "run_finalization_completed" ? commitResult.status : undefined)
        ?? (event.event === "run_finalization_failed" ? "failed" : undefined),
      outcome: data.outcome ?? data.requestedOutcome ?? finalization.outcome,
      validation: data.validation ?? finalization.validation,
      commit: data.taskCommit ?? commitResult.commit ?? finalization.commit,
      commitCreated: data.taskCommitCreated
        ?? (commitResult.status === "committed" ? true : undefined)
        ?? finalization.commitCreated,
      headAfter: data.taskHeadAfter ?? commitResult.headAfter ?? repository.headAfter ?? finalization.headAfter,
    }));
  }
  return [...records.values()]
    .filter((item) => item.taskId)
    .sort((left, right) => String(left.taskId ?? left.runId).localeCompare(String(right.taskId ?? right.runId)));
}

function isTaskLifecycleEvent(name, data, nested) {
  return [
    "run_task_bound",
    "agent_routed",
    "run_finalization_started",
    "run_finalization_completed",
    "run_finalization_failed",
    "task_commit_created",
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
