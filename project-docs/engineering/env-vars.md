# Environment Variables

Provider keys:

```env
OPENAI_API_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
FIREWORKS_API_KEY=
```

Model selection:

- Chat, embedding, and image generation model choices live in `ayati-main/data/runtime/llm-config.json`.
- Optional chat-model context overrides live in the same file under
  `modelContextLimits`, keyed as `<provider>:<model>`. Each override declares
  `contextWindowTokens` and may declare `maxInputTokens` and
  `outputReserveTokens`, `recoveryTargetTokens`, `softInputTokens`, and
  `hardInputTokens`. Ayati accepts 128K and larger context windows. The default
  128K pressure thresholds are 60K recovery, 70K soft, and 100K hard.
- Embeddings currently support the OpenAI provider and use `OPENAI_API_KEY`.
- Image generation currently supports the OpenAI provider and uses `OPENAI_API_KEY`.

Example context override:

```json
{
  "modelContextLimits": {
    "anthropic:claude-large-context": {
      "contextWindowTokens": 200000,
      "maxInputTokens": 180000,
      "outputReserveTokens": 12000,
      "recoveryTargetTokens": 90000,
      "softInputTokens": 110000,
      "hardInputTokens": 150000
    }
  }
}
```

HTTP API:

```env
AYATI_HTTP_HOST=127.0.0.1
AYATI_HTTP_PORT=8081
AYATI_HTTP_ALLOW_ORIGIN=*
AYATI_HTTP_API_TOKEN=
AYATI_UPLOAD_MAX_BYTES=26214400
```

Document vectors:

```env
AYATI_DOCUMENT_VECTOR_ENABLED=true
AYATI_DOCUMENT_EMBED_BATCH_SIZE=32
AYATI_DOCUMENT_VECTOR_MIN_CHUNKS=40
```

Document extraction:

```env
TIKA_BIN=tika
TIKA_JAR_PATH=
PANDOC_BIN=pandoc
PDFTOTEXT_BIN=pdftotext
```

Python tool:

```env
AYATI_PYTHON_INTERPRETER=
```

Workspace defaults:

```env
AYATI_WORKSPACE_DIR=
```

`AYATI_WORKSPACE_DIR` sets the default directory for generated files, scratch
work, filesystem tools, shell cwd, and other ad-hoc agent work when the user
does not specify a directory. When unset, Ayati uses `ayati-main/work_space`.
Relative tool paths are already resolved inside this workspace root, so agents
should pass `report.md` instead of `work_space/report.md`.

Git context:

```env
AYATI_GIT_CONTEXT_STORE_DIR=
AYATI_GIT_CONTEXT_DATABASE=
AYATI_GIT_CONTEXT_DATA_ROOT=
AYATI_GIT_CONTEXT_SOCKET=
AYATI_GIT_CONTEXT_MANAGED=true
AYATI_GIT_CONTEXT_START_TIMEOUT_MS=10000
AYATI_GIT_CONTEXT_STOP_TIMEOUT_MS=10000
AYATI_GIT_CONTEXT_REQUEST_TIMEOUT_MS=30000
AYATI_GIT_CONTEXT_TIMEZONE=Asia/Kolkata
AYATI_GIT_CONTEXT_AGENT_ID=local
```

Daily Git context is always on. By default, the daemon starts one independent
`ayati-git-context` child process and communicates with it through HTTP/JSON on
a local Unix socket. That process is the sole owner of context SQLite and Git
writes. The daemon waits for protocol-compatible readiness before accepting
work, stops the child during normal shutdown, and can restart it once after an
observed crash. Set `AYATI_GIT_CONTEXT_MANAGED=false` only when an externally
supervised compatible server already owns the configured socket.

`AYATI_GIT_CONTEXT_STORE_DIR` overrides the context-engine storage directory.
When unset, Ayati uses `ayati-main/data/context-engine`. Relative paths resolve
from the backend package root.

`AYATI_GIT_CONTEXT_DATABASE` and `AYATI_GIT_CONTEXT_SOCKET` override the
SQLite database and Unix-socket paths. Their defaults are `context.sqlite` and
`git-context.sock` inside the store directory. `AYATI_GIT_CONTEXT_DATA_ROOT`
overrides the Git repository root; its default is `.ayati-context` inside the
configured workspace. The three timeout values bound service readiness,
graceful shutdown, and each HTTP request.

`AYATI_GIT_CONTEXT_TIMEZONE` controls daily session dating for git context.

`AYATI_GIT_CONTEXT_AGENT_ID` controls the agent id used in daily session ids.

Agent harness:

```env
AYATI_AGENT_MAX_SELECTED_TOOLS=12
```

`AYATI_AGENT_MAX_SELECTED_TOOLS` bounds how many selected executable tool
schemas are shown to the decision model for one decision. Required routing and
Git recovery tools consume slots inside this total. After enforced context
pressure, later decisions use the smaller of this value and ten. Native harness
control tools are separate from this executable-tool limit.

Feedback tracing:

```env
AYATI_TEST_AGENT=1
AYATI_FEEDBACK_TRACE=1
AYATI_FEEDBACK_FULL=
```

Use `pnpm dev:main:feedback` or `pnpm start:main:feedback` to enable feedback
tracing for local agent development. Feedback traces are disabled unless both
`AYATI_TEST_AGENT` and `AYATI_FEEDBACK_TRACE` are truthy. By default, large
payloads are compacted; set `AYATI_FEEDBACK_FULL=1` only when raw payload detail
is needed for debugging.

Git Context Engine, HTTP, supervisor, and harness lifecycle events use the same
feedback trace. They include correlation identifiers, cache revisions,
persistence acknowledgements, durations, and outcomes without requiring a
separate environment flag. Run `pnpm feedback:git-context` to inspect the
latest recorded context lifecycle.
