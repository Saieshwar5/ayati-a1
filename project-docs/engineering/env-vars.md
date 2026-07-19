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

## Ayati Root

```env
AYATI_ROOT_DIR=
```

This is the single filesystem root for managed work:

- `<root>/workspace/`: default visible output when the user gives no path;
- `<root>/workstreams/`: context-only `W-*` repositories;
- `<root>/.ayati/`: SQLite, sessions, immutable managed resources, and socket.

When unset, the backend uses `ayati-main/ayati`. Model-facing tool calls still
use canonical absolute resource paths.

## Git Context

```env
AYATI_GIT_CONTEXT_DATABASE=
AYATI_GIT_CONTEXT_SOCKET=
AYATI_GIT_CONTEXT_MANAGED=true
AYATI_GIT_CONTEXT_START_TIMEOUT_MS=10000
AYATI_GIT_CONTEXT_STOP_TIMEOUT_MS=10000
AYATI_GIT_CONTEXT_REQUEST_TIMEOUT_MS=30000
AYATI_GIT_CONTEXT_TIMEZONE=Asia/Kolkata
AYATI_GIT_CONTEXT_AGENT_ID=local
```

Database and socket defaults are `<root>/.ayati/context.db` and
`<root>/.ayati/git-context.sock`. The daemon normally manages one compatible
local child process. Set `AYATI_GIT_CONTEXT_MANAGED=false` only when another
supervisor owns that socket. Parent-PID and root values passed to the child are
internal process inputs.

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
