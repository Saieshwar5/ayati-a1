# Runtime Performance Benchmarking

This benchmark suite measures Ayati runtime behavior that is not caused by LLM
latency, model quality, prompt design, or provider availability. It is meant to
catch local data-structure, algorithm, persistence, and daemon-load regressions
before they show up as slow agent turns.

It complements, but does not replace, the agent harness benchmark. The agent
benchmark measures:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

The runtime performance benchmark measures the local subsystems underneath that
flow. These are the paths that decide how quickly the daemon can retrieve
context, select local tools, drain integration events, and serve files before an
LLM call is even made:

- context/state-view construction
- tool selection and tool executor indexing
- focus-card search and shelf building
- personal memory FTS and candidate lookup
- document vector fallback retrieval
- filesystem search tools
- inbound system-event queue throughput
- Pulse due-occurrence leasing
- HTTP upload and artifact serving

## Commands

Run the default standard suite:

```bash
pnpm --filter ayati-main bench:runtime
```

Run a quick smoke suite:

```bash
pnpm --filter ayati-main bench:runtime -- --scale=smoke
```

Run a larger stress suite:

```bash
pnpm --filter ayati-main bench:runtime -- --scale=stress
```

List cases:

```bash
pnpm --filter ayati-main bench:runtime -- --list
```

Run one case:

```bash
pnpm --filter ayati-main bench:runtime -- --case focus_store --scale=standard
```

Write output to a stable path:

```bash
pnpm --filter ayati-main bench:runtime -- --output=data/benchmarks/runtime-debug --scale=smoke
```

## When To Run

Use the smallest benchmark that answers the question:

- `smoke`: quick local check after benchmark or subsystem changes.
- `standard`: normal development signal before merging performance-sensitive
  changes.
- `stress`: scaling check for queue, scheduler, memory, document, and tool
  changes. Stress numbers are expected to vary by machine, so compare repeated
  runs on the same host.

Run a single `--case` when working on one subsystem. Run the full suite when
changing shared runtime behavior, persistence schema, tool registration, daemon
servers, or memory/context retrieval.

## Reports

Reports are written under:

```text
ayati-main/data/benchmarks/runtime-performance/<timestamp>/
```

Main files:

```text
runtime-performance-summary.json
runtime-performance-results.json
runtime-performance-summary.md
```

Each operation records:

- fixture size
- iteration count
- total measured items
- p50, p95, p99, mean, min, and max latency
- operations per second
- heap delta
- soft warnings when p95 exceeds the initial threshold

Warnings are advisory until stable baselines exist. Use several local runs on
the same machine before turning any threshold into a hard failure.

## Reading The Report

Use the report to separate model behavior from daemon behavior:

- `p50` shows typical local latency.
- `p95` and `p99` show tail latency that users feel during larger projects,
  backlogs, or concurrent file operations.
- `ops/sec` shows throughput for batch paths such as queues, scheduler leasing,
  uploads, and filesystem scans.
- `heap delta` shows whether a path allocates too much memory for the fixture
  size.
- `fixture` explains the scale of the generated workload, which makes smoke,
  standard, and stress runs comparable.

The main pattern to look for is scaling. If stress is 10x larger than standard
but p95 grows 40x, the subsystem probably has avoidable repeated work,
per-record transactions, full scans, or whole-result sorting.

## Case Map

| Case | What It Exercises | Improvement Signal |
|------|-------------------|--------------------|
| `context_tool_selection` | state-view construction, tool scoring, dynamic tool visibility | Precompute searchable tool metadata, cache tokenized state, or avoid sorting every tool when tool count grows. |
| `focus_store` | session/global shelves, SQLite text filtering, identity upsert | Add better text indexes, normalize JSON lookup fields, or reduce in-memory scoring work. |
| `personal_memory` | FTS memory search, evolution candidate lookup, prompt snapshot read | Inspect FTS plans, cap candidate paths, merge repeated lookups, or add indexes for hot filters. |
| `document_vector_fallback` | JSON fallback vector reads, cosine scoring, top-k retrieval | Cache parsed fallback records, avoid full sorting, shard fallback files, or use indexed vector storage for larger datasets. |
| `filesystem_tools` | recursive filename and content search over workspace trees | Prefer `rg` when available, skip ignored/heavy directories, add extension filters, or avoid queue operations that shift large arrays. |
| `inbound_queue` | enqueue, dedupe, and claiming under backlog | Claim batches in one transaction and verify indexes support pending-event ordering. |
| `pulse_scheduler` | due reminder listing, occurrence materialization, lease claiming | Split materialization from leasing, use set-based SQL, increase lease batches, and avoid repeated per-row reads. |
| `http_server` | artifact downloads and multipart uploads with local concurrency | Watch for buffering, stream pressure, upload size limits, and heap growth under concurrent clients. |

## How This Helps The Agent

The LLM can only use context that the daemon retrieves and packages in time.
If memory lookup, focus shelves, document search, filesystem tools, or queues
become slow, the agent becomes slower and may receive weaker context even when
the model itself is unchanged.

Useful signals:

- Focus search p95 grows linearly as cards increase: consider better indexing
  or normalized artifact/entity tables.
- Personal memory candidate lookup degrades as cards grow: inspect FTS queries,
  address indexes, and alias lookup.
- Document vector fallback slows with many chunks: prefer LanceDB or avoid the
  JSON fallback for large stores.
- Filesystem search slows on large trees: consider `rg`, extension filters,
  ignored-directory rules, or cached indexes.
- Queue claim throughput drops under backlog: inspect SQLite indexes and
  transaction shape.
- Upload p95 or heap grows with concurrency: inspect request buffering and
  streaming behavior.

Compare smoke, standard, and stress results to understand scaling instead of
only single-run speed.
