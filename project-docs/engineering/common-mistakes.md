# Common Mistakes

Avoid these:

- Treating Ayati as a single prompt wrapper instead of an autonomous harness runtime.
- Reintroducing separate `understand`, `direct`, or `reeval` controller stages instead of improving the current decision-action-reducer runner.
- Treating Ayati as a CLI-only chatbot.
- Building core intelligence, memory, or tool behavior into the CLI instead of the daemon.
- Forgetting that `ayati-main` is intended to run continuously.
- Treating memory as optional storage instead of a central personalization layer.
- Assuming every interaction is synchronous chat; system events and background work are part of the product.
- Coupling provider-specific behavior into the core loop when provider abstraction should handle it.
- Adding a new tool without validation and tests.
- Changing prompt context without considering token budget, the structured context pack, and deterministic workstream/resource resolution.
- Adding tool-loading behavior in prompt prose instead of the tool taxonomy,
  working-set policy, and focused tests.
- Loading process tools for generic create/build requests when file
  create/write/read tools are the safer deterministic default.
- Solving read loops by storing all raw file context in workstream state instead of
  using hot read context, observations, and run evidence.
- Adding model-callable lifecycle tools for workstream state updates or commits
  instead of keeping those deterministic in runtime finalization.
- Assuming a previously active or obvious workstream may be mutated without an
  explicit request decision and exact mutable resource.
- Creating a new workstream for every feature, lesson, or run instead of adding a
  request to the same durable workstream when ownership is clear.
- Putting project files or deliverables in the workstream context repository.
- Editing `workstream.md`, request files, or `resources.json` directly from
  general tools instead of letting runtime finalization own them.
- Loading every workstream repository, old conversation, or raw output record into the
  default prompt instead of using compact active context, Context Engine retrieval,
  and narrower domain-tool calls.
- Committing attachments, deliverables, raw transcripts, runtime databases, or
  external-action payloads into workstream context Git.
- Writing runtime state into source-controlled docs.
- Ignoring `context/system-event-policy.json`.
- Breaking CLI/server message contracts.
- Assuming a browser frontend exists in the current active product.
- Running tests that require real provider credentials without isolating them.
- Exposing process/filesystem/Python/database capabilities to untrusted users.
