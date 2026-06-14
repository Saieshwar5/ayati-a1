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
- Changing prompt context without considering token budget, the structured context pack, and attention shelf behavior.
- Writing runtime state into source-controlled docs.
- Ignoring `context/system-event-policy.json`.
- Breaking CLI/server message contracts.
- Assuming a browser frontend exists in the current active product.
- Running tests that require real provider credentials without isolating them.
- Exposing shell/filesystem/Python/database capabilities to untrusted users.
