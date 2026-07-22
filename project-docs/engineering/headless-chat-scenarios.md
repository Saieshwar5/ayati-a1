# Headless Chat Scenarios

Use this workflow to test Ayati through the same WebSocket path as a human
client.

## Start With Live Evaluation

```bash
pnpm eval:agent -- live --name headless-chat
# add --watch for the development rebuild/restart path
```

Connect to `ws://localhost:8080` and send:

```json
{ "type": "chat", "content": "Build a small coffee shop website." }
```

Send one message, wait for a terminal response and finalization
acknowledgement, inspect the generated evidence/resources, then send the next
message. Do not overlap turns.

Terminal responses are `reply`, `feedback`, `error`, `reply_done`, or a
`notification` with `final: true`. Progress and streaming deltas are not
terminal. A `feedback` question is answered with the next ordinary chat
message.

## Scenario Set

Exercise at least:

1. casual conversation (zero-step unbound run);
2. list/search/read in the default workspace or an admitted resource;
3. ambiguous durable ownership and focused clarification;
4. a new workstream with output under `<AYATI_ROOT_DIR>/workspace/`;
5. a second and third materially different workstream;
6. return to each using title and resource cues;
7. continue an active request versus create a new request;
8. interruption before and during finalization.

Keep deliverables intentionally small to control provider cost.

## Inspect After Every Turn

```text
ayati-main/data/evaluations/<evaluation-id>/runs/<run-id>/report.md
ayati-main/data/evaluations/<evaluation-id>/session-report.md
```

Run `pnpm eval:agent -- inspect --evaluation <id> --latest` for the latest
evidence-linked turn report. `pnpm feedback:context-engine` is a compatibility
alias for the unified latest report. Also inspect:

- run, step, workstream, request, resource, binding, and journal database rows;
- `<AYATI_ROOT_DIR>/workstreams/<W-*>/workstream.md`;
- request files and `resources.json`;
- context Git status and history;
- real deliverables at resource locators;
- reusable read context and restart/reopen behavior.

Success requires agreement among final text, feedback, SQLite, context Git, and
real resources. A polished reply alone is insufficient.

## Report

The recorder supplies each message, response, duration, final type, deterministic
finding, repair, selected workstream/request, resources, context commit state,
and exact evidence links. Use `eval:agent annotate` for intended outcomes,
observed usefulness, user feedback, coding-agent conclusions, and proposed
experiments. Review each report before adapting the next live message.
