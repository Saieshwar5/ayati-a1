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
- Embeddings currently support the OpenAI provider and use `OPENAI_API_KEY`.
- Image generation currently supports the OpenAI provider and uses `OPENAI_API_KEY`.

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
AYATI_GIT_CONTEXT_TIMEZONE=Asia/Kolkata
AYATI_GIT_CONTEXT_AGENT_ID=local
```

Daily git context is always on. It records session conversation in the
session-store submodule, pending-turn ownership, active task refs, task
branches, task assets, run summaries, evidence manifests, session summaries
when present, and commit metadata. The model-facing
prompt uses grouped paths such as `context.git`, `context.timeline`,
`context.scratch`, `context.harness`, `context.tools`, and
`context.personal`.

`AYATI_GIT_CONTEXT_STORE_DIR` overrides the context-engine storage directory.
When unset, Ayati uses `ayati-main/data/context-engine`. Relative paths resolve
from the backend package root.

`AYATI_GIT_CONTEXT_TIMEZONE` controls daily session dating for git context.

`AYATI_GIT_CONTEXT_AGENT_ID` controls the agent id used in daily session ids.

Agent harness:

```env
AYATI_AGENT_MAX_SELECTED_TOOLS=12
```

`AYATI_AGENT_MAX_SELECTED_TOOLS` bounds how many selected executable tool
schemas are shown to the decision model for one decision.

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
