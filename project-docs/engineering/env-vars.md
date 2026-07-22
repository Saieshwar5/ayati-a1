# Environment Variables

## Providers

```env
OPENAI_API_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
FIREWORKS_API_KEY=
```

Chat, embedding, image, and context-window model settings live in
`ayati-main/data/runtime/llm-config.json`. OpenAI embeddings and image
generation require `OPENAI_API_KEY`.

A model context profile may contain:

```json
{
  "contextWindowTokens": 128000,
  "outputReserveTokens": 8192,
  "preparationInputTokens": 55000,
  "recoveryTargetTokens": 60000,
  "softInputTokens": 70000,
  "hardInputTokens": 100000
}
```

`preparationInputTokens` is optional. Its default is `55_000 / 128_000` of
the configured context window; the other default pressure thresholds scale in
the same way. Profiles must satisfy:

```text
0 < preparation < recovery < soft < hard <= input capacity
```

Input capacity is the smaller of an optional model `maxInputTokens` and the
context window minus output reserve. The default 128K profile uses the exact
values above. The runtime also applies a conservative 95% local-estimate
admission limit until an exact provider count is available.

## Ayati Root

```env
AYATI_ROOT_DIR=
```

This is the single filesystem root for managed work:

- `<root>/workspace/`: default visible output when the user gives no path;
- `<root>/workstreams/`: context-only `W-*` repositories;
- `<root>/.ayati/`: Context Engine SQLite and immutable managed resources.

When unset, the backend uses `ayati-main/ayati`. Model-facing tool calls still
use canonical absolute resource paths.

## Context Engine

```env
AYATI_CONTEXT_ENGINE_DATABASE=
AYATI_CONTEXT_ENGINE_TIMEZONE=Asia/Kolkata
AYATI_CONTEXT_ENGINE_AGENT_ID=local
```

The database defaults to `<root>/.ayati/context.db`. The daemon opens one
in-process engine, acquires the database writer lock, completes startup
recovery, and closes it during daemon shutdown.

The previous `AYATI_GIT_CONTEXT_DATABASE`, `AYATI_GIT_CONTEXT_TIMEZONE`, and
`AYATI_GIT_CONTEXT_AGENT_ID` names remain accepted during the internal naming
transition. Socket, managed-process, and transport-timeout settings have been
removed.

## HTTP and Uploads

```env
AYATI_HTTP_HOST=127.0.0.1
AYATI_HTTP_PORT=8081
AYATI_HTTP_ALLOW_ORIGIN=*
AYATI_HTTP_API_TOKEN=
AYATI_UPLOAD_MAX_BYTES=26214400
```

## Documents and Python

```env
AYATI_DOCUMENT_VECTOR_ENABLED=true
AYATI_DOCUMENT_EMBED_BATCH_SIZE=32
AYATI_DOCUMENT_VECTOR_MIN_CHUNKS=40
TIKA_BIN=tika
TIKA_JAR_PATH=
PANDOC_BIN=pandoc
PDFTOTEXT_BIN=pdftotext
AYATI_PYTHON_INTERPRETER=
```

Other `AYATI_PYTHON_*` variables are runtime-owned child-process inputs, not
normal operator configuration.

## Harness and Feedback

```env
AYATI_AGENT_MAX_SELECTED_TOOLS=15
AYATI_TEST_AGENT=1
AYATI_FEEDBACK_TRACE=1
AYATI_FEEDBACK_FULL=
AYATI_AGENT_TRACE=
AYATI_AGENT_TRACE_PROMPTS=
```

Feedback files are written only when both test-agent and feedback-trace flags
are truthy. Full payload tracing and prompt tracing can contain sensitive data;
enable them only for deliberate local debugging.

The supported real-daemon evaluation entry point is `pnpm eval:agent -- live`.
It sets runtime-owned `AYATI_EVALUATION_ID`, `AYATI_EVALUATION_NAME`,
`AYATI_EVALUATION_CAPTURE`, `AYATI_EVALUATION_ROOT`, and
`AYATI_EVALUATION_COMMAND` values for the spawned ordinary daemon. Do not set
these variables manually. Evaluation capture does not change `AYATI_ROOT_DIR`,
provider/model selection, prompts, tools, schedulers, or background services.
