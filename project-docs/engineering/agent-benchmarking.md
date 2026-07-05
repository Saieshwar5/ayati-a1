# Agent Benchmarking

Ayati optimization must start from measured harness behavior, not prompt edits.
The benchmark surface is the full agent loop:

```text
context pack -> decision -> action executor -> deterministic verification -> progress reducer
```

## Runtime References

- `ayati-main/src/ivec/agent-runner/runner.ts`: loop orchestration, state snapshots, compaction, verification recording, and final result creation.
- `ayati-main/src/ivec/agent-runner/decision.ts`: decision prompt construction, model call timing, and provider usage recording.
- `ayati-main/src/ivec/agent-runner/context-pack.ts`: bounded context pack fields and truncation limits.
- `ayati-main/src/ivec/agent-runner/state-view.ts`: sparse model-facing state view.
- `ayati-main/src/ivec/metrics.ts`: optimization summaries and event log persistence.
- `ayati-main/src/providers/fireworks/index.ts`: Fireworks OpenAI-compatible chat adapter.
- `ayati-main/src/benchmarks/agent-benchmark-runner.ts`: deterministic benchmark runner and case recipes.

## Metrics Captured

Every agent run writes:

```text
data/runs/<runId>/optimization-summary.json
data/runs/<runId>/optimization-events.jsonl
```

The optimization summary captures:

- LLM, tool, and local decision call counts.
- Stage call counts, failures, total latency, and max latency.
- Prompt characters and estimated tokens by prompt section.
- Decision prompt cache-layout sections:
  `system.stableDecisionRules`, `system.runtimeContext`, `user.tools`, and
  `user.state`.
- Context growth between decision prompts, including total prompt deltas,
  section deltas, and state-view sub-section deltas.
- Work state and completed step compaction before/after sizes.
- State size snapshots at initial, after-step, and final points.
- Plan mode counts.
- Verification method counts.
- Provider token usage and estimated cost when a provider returns usage.

The event log captures timestamped prompt, compaction, state-size, provider-usage,
plan-mode, verification, context-growth, and warning events.

## Fireworks Token Usage

Fireworks uses an OpenAI-compatible chat completions API. The response can include
real token usage:

```json
{
  "usage": {
    "prompt_tokens": 1000,
    "completion_tokens": 250,
    "total_tokens": 1250,
    "prompt_tokens_details": {
      "cached_tokens": 400
    }
  }
}
```

Ayati keeps local pre-call token estimates for prompt budgeting and records
post-call Fireworks usage for benchmark accuracy. When Fireworks does not return
usage, the run still succeeds but cost and exact token fields are absent.

Fireworks documentation:

- Chat completions API: `https://docs.fireworks.ai/api-reference/post-chatcompletions`
- OpenAI compatibility and usage behavior: `https://docs.fireworks.ai/tools-sdks/openai-compatibility`
- Serverless pricing: `https://docs.fireworks.ai/serverless/pricing`

## Fireworks Cost Estimate

Cost is calculated from real token usage and a local pricing table. The initial
table covers the configured MiniMax models used by Ayati. For MiniMax 2.5,
Fireworks serverless standard pricing is:

```text
input:        $0.30 / 1M tokens
cached input: $0.03 / 1M tokens
output:       $1.20 / 1M tokens
```

Formula:

```text
uncached_input = prompt_tokens - cached_tokens

cost =
  uncached_input * input_price / 1_000_000
  + cached_tokens * cached_input_price / 1_000_000
  + completion_tokens * output_price / 1_000_000
```

Pricing changes over time, so benchmark reports include the pricing source.

## Benchmark Suite

Run:

```bash
pnpm --filter ayati-main bench:agent
```

The suite is deterministic and uses a mock decision provider. It does not spend
provider credits.

Run one case:

```bash
pnpm --filter ayati-main bench:agent -- --case multistep_bugfix_slugify
```

List cases:

```bash
pnpm --filter ayati-main bench:agent -- --list
```

Filter by tier or category:

```bash
pnpm --filter ayati-main bench:agent -- --tier multistep
pnpm --filter ayati-main bench:agent -- --category coding
```

Write output to a stable path:

```bash
pnpm --filter ayati-main bench:agent -- --case small_file_edit --output=data/benchmarks/debug-small-edit
```

Run PDF/file-handling benchmarks:

```bash
pnpm --filter ayati-main bench:file -- --pdf-dir ~/Downloads --max-pdfs 2
```

Run one PDF case with one explicit file:

```bash
pnpm --filter ayati-main bench:file -- --case pdf_query_single_document --pdf ~/Downloads/example.pdf
```

Run the two-document comparison with explicit files:

```bash
pnpm --filter ayati-main bench:file -- --case pdf_multi_document_compare --pdf ~/Downloads/first.pdf --pdf ~/Downloads/second.pdf --max-pdfs 2
```

By default, file benchmarks look for PDFs in `~/Downloads`. If no suitable PDF
is available, the PDF case writes a skipped benchmark result instead of failing
the whole command. Use `--require-pdf` when a missing PDF should fail the run.
PDF extraction currently uses Tika first and falls back to `pdftotext`.
Configure `TIKA_BIN`, `TIKA_JAR_PATH`, or `PDFTOTEXT_BIN` when those binaries
are not on `PATH`. If no PDF extractor is available, real PDF cases fail with a
captured preparation error in `document-preparation.json`.

Current cases:

- `direct_reply_basic`: direct answer, no tools.
- `code_search_context_pack`: search for the context pack implementation.
- `small_file_edit`: edit one fixture file and verify the final answer does not expose harness internals.
- `pdf_prepare_smoke`: register one PDF, prepare it, and list available sections.
- `pdf_query_single_document`: query one PDF through prepared document retrieval.
- `pdf_section_read_exact`: list section handles and read the first section/page.
- `pdf_multi_document_compare`: attach two PDFs and query them separately for comparison.
- `pdf_large_context_budget`: select the largest available PDF and measure bounded retrieval/context growth.
- `pdf_bad_file_recovery`: create an invalid PDF fixture and verify extraction failure is captured in reports.
- `multistep_bugfix_slugify`: create a buggy slugify mini-project, run a failing test, fix the source, and rerun the test.
- `feature_add_average_helper`: add an `average(numbers)` helper and tests to a small calculator module.
- `large_context_update_relevant_doc`: create a noisy workspace and update only the relevant context-pack doc.
- `followup_continue_previous_file_edit`: run a two-step continuation task that adds TTL behavior to sync and async cache files.
- `missing_directory_recovery`: create a file under a missing directory and verify local recovery.

Artifacts are written under:

```text
ayati-main/data/benchmarks/agent-harness/<timestamp>/
```

Main files:

```text
benchmark-summary.json
benchmark-results.json
benchmark-summary.md
human-review.md
<case-id>/benchmark-result.json
<case-id>/step-trace.json
<case-id>/step-trace.md
<case-id>/tool-calls.json
<case-id>/provider-usage.json
<case-id>/prompt-metrics.json
<case-id>/context-growth.json
<case-id>/pdf-manifest.json
<case-id>/document-preparation.json
<case-id>/document-tool-calls.json
<case-id>/file-handling-summary.json
<case-id>/diff.patch
<case-id>/fixture-before/
<case-id>/fixture-after/
<case-id>/<run-id>/optimization-summary.json
<case-id>/<run-id>/optimization-events.jsonl
```

Each benchmark recreates a fresh fixture workspace before it runs. Agent edits
do not modify the case recipe, so the same benchmark can run repeatedly from a
clean buggy or incomplete state.

PDF benchmarks copy selected source PDFs into a temporary benchmark workspace
before registration. Reports include local source paths, copied benchmark paths,
file size, checksum, extractor, section count, chunk count, document tool counts,
provider subcall stats, prompt metrics, and context growth. Reports do not write
full extracted PDF text as a top-level benchmark artifact. Runtime data under
`ayati-main/data/` remains ignored by git.

## Programmatic Scoring

Each benchmark case should score:

- task status: completed, failed, or stuck
- run class: interaction or task
- total iterations
- total tool calls
- provider token usage
- prompt estimated tokens
- final answer required content
- final answer forbidden internal wording
- file content or diff expectations for edit tasks
- verification method and validation status where relevant
- benchmark budgets for model calls, tool calls, total tokens, and latency
- fixture before/after diffs for coding tasks

Per-case reports preserve the agent's work trace:

- `step-trace.md`: human-readable sequence of decisions, tools, verification, and output previews.
- `tool-calls.json`: flat list of tool-related trace entries.
- `provider-usage.json`: provider usage totals captured from the run metrics.
- `prompt-metrics.json`: prompt section size and estimated token data.
- `context-growth.json`: per-decision prompt growth, context deltas, and
  state-view growth by `context`, `progress`, `workingFeedback`, `toolLoad`,
  `observations`, and `attachments`.
- `diff.patch`: text diff between `fixture-before` and `fixture-after`.

Prompt metrics should make cache efficiency visible. The stable decision
contract belongs in `system.stableDecisionRules`; dynamic runtime context
belongs in `system.runtimeContext`; selected tool schemas belong in
`user.tools`; and the model-facing state view belongs in `user.state`. If
future changes move volatile data into the stable system section, treat that as
a cache-regression risk even when deterministic benchmark checks still pass.

Useful budgets:

```text
max model calls
max tool calls
max total tokens
max prompt tokens
max context delta tokens per decision
max latency
max estimated cost
max state size
```

Budgets should be warnings at first. Turn them into hard failures only after a
stable baseline exists.

## Human Eval Rubric

Use `human-review.md` for manual review. Score each case:

```text
Correctness: 1-5
Instruction following: 1-5
Tool judgment: 1-5
Context focus: 1-5
Final answer quality: 1-5
Efficiency: 1-5
Risk: low / medium / high
```

Human review should focus on things deterministic checks cannot fully measure:

- Did the agent understand the user intent?
- Did it use tools only when useful?
- Did it preserve focus across follow-ups?
- Did it avoid over-reading and repeated work?
- Did it make a minimal, maintainable edit?
- Did it avoid mentioning internal concepts such as work state, deterministic verification, reducers, or harness steps?

For PDF/file-handling cases, also score:

- Did the answer stay grounded in the attached PDF content?
- Did the agent select the correct PDF when multiple documents were attached?
- Did it use `document_list_sections`, `document_read_section`, and
  `document_query` appropriately for the task?
- Did context growth stay proportional to the task instead of pulling excessive
  document text into the prompt?
- Was any extraction failure explained clearly enough for debugging?

## Expansion Plan

Add these cases after the current deterministic suite is stable:

- attachment query over a prepared document
- managed file or directory restoration
- system event handling
- large tool output and evidence chunk access
- ambiguous user request requiring clarification
- real-provider smoke benchmark for Fireworks usage and latency

Run deterministic mock-provider benchmarks often. Run real-provider benchmarks
less often because they cost money, vary with network/provider latency, and can
be affected by model updates.
