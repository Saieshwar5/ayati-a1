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
  const fallbackPointer = resolve(dataRoot, "feedback", "latest.json");
  const latest = JSON.parse(await readFile(sessionPointer, "utf8").catch(() =>
    readFile(fallbackPointer, "utf8")));
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
  const findings = validate(contextEvents);
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
    findings.length === 0 ? "PASS — no deterministic lifecycle violations found." : `FAIL — ${findings.length} lifecycle violation(s) found.`,
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
    `- Task promotions: ${counts.get("run_promoted") ?? 0}`,
    `- Verified task mutations staged: ${counts.get("task_mutation_staged") ?? 0}`,
    `- Task finalizations: ${counts.get("task_finalization_completed") ?? 0}`,
    `- Child restarts: ${counts.get("child_restart_completed") ?? 0}`,
    "",
    "## Timeline",
    "",
    "Time | Component | Event | Run | Task | Step | Outcome | ms | Revision",
    "--- | --- | --- | --- | --- | ---: | --- | ---: | ---",
    ...rows,
    "",
  ].join("\n");
}

function validate(events) {
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
  pair(events, "task_finalization_started", "task_finalization_completed", (event) => event.runId, findings, new Set(["task_finalization_failed"]));
  pair(events, "run_promotion_started", "run_promoted", (event) => event.runId, findings);
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
      findings.push(`verified mutation was not staged for task-run finalization: ${authorityId}`);
    }
  }
  return [...new Set(findings)];
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
