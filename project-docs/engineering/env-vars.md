# Environment Variables

## Providers

```env
OPENAI_API_KEY=
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
FIREWORKS_API_KEY=
AYATI_LLM_REQUEST_TIMEOUT_MS=120000
```

Chat and context-window model settings live in
`ayati-main/data/runtime/llm-config.json`.

LLM generation uses the explicit request timeout above, accepts values from
1,000 through 600,000 milliseconds, and defaults to 120 seconds. Provider SDK
retries are disabled for these generation requests. The foreground decision
boundary retries one transient timeout, connection, rate-limit, or server
failure with the exact same compiled input; permanent account/configuration
failures and unknown errors are not retried.

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
- `<root>/workstreams/`: one context-only repository containing `W-*`
  directories;
- `<root>/.ayati/`: Context Engine SQLite and immutable managed resources.

When unset, the backend uses `ayati-main/ayati`. Model-facing tool calls still
use canonical absolute resource paths.

## Filesystem Access Policy

```env
AYATI_FILESYSTEM_READ_SCOPE=machine
AYATI_FILESYSTEM_MUTATION_SCOPE=workspace
```

These are strict operator-owned enums:

- read scope: `machine` or `workspace`;
- mutation scope: `workspace` or `bound_resource`.

The current defaults are `machine` and `workspace`. `machine` permits the core
filesystem observation tools to use explicit absolute paths readable by the
daemon's operating-system account; omitted search roots still use
`<AYATI_ROOT_DIR>/workspace/`. `workspace` requires every declared filesystem
effect to remain canonically inside `<AYATI_ROOT_DIR>/workspace/` before
normal workstream/resource mutation gates run. Tool inputs cannot override
these values. Invalid values stop configuration loading.

`bound_resource` is retained as an operator switch for the prior external
bound-resource mutation boundary. It should not be enabled without a separate
trust and deployment review.

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
AYATI_UPLOAD_MAX_BYTES=26214400
```

## Electron Desktop Client

```env
AYATI_DESKTOP_WS_URL=ws://127.0.0.1:8080
```

This variable is read by the Electron main process. Plaintext `ws:` values are
accepted only for loopback hosts; a non-loopback endpoint must use `wss:` and
still requires a separate trusted deployment and authentication design.

## Voice Input

```env
AYATI_VOICE_ENABLED=true
AYATI_VOICE_AUTO_SEND=false
AYATI_VOICE_NOTIFICATIONS=true
AYATI_VOICE_SHOW_TRANSCRIPT=true
AYATI_VOICE_SHOW_REPLY=true
AYATI_VOICE_COMMAND=voxtype
AYATI_VOICE_TRANSCRIPTION_TIMEOUT_MS=90000
AYATI_VOICE_MAX_TRANSCRIPT_CHARS=32000
AYATI_VOICE_SOCKET_PATH=
```

Voice input is enabled by default and uses the installed Voxtype user daemon
for local recording and Whisper transcription. Confirmation is the safe
default: after transcription, activate the voice key again to send. Set
`AYATI_VOICE_AUTO_SEND=true` to send immediately.

The default control socket is `$XDG_RUNTIME_DIR/ayati/voice.sock` with user-only
permissions. `AYATI_VOICE_SOCKET_PATH`, when set, must be absolute and must be
given to both daemon and CLI environments. Transcript and reply previews can
be hidden independently for sensitive desktop environments.

## Document Extraction and Python

```env
TIKA_BIN=tika
TIKA_JAR_PATH=
PANDOC_BIN=pandoc
PDFTOTEXT_BIN=pdftotext
AYATI_PYTHON_INTERPRETER=
```

Other `AYATI_PYTHON_*` variables are runtime-owned child-process inputs, not
normal operator configuration.

## Harness and Evaluation

```env
AYATI_AGENT_MAX_CAPABILITY_SURFACE_TOOLS=8
AYATI_AGENT_TRACE=
AYATI_AGENT_TRACE_PROMPTS=
```

Agent and prompt tracing can contain sensitive data; enable it only for
deliberate local debugging. With machine read scope, readable host-file content
may also be sent to the configured model provider and retained in the run
journal even when tracing is disabled.

The supported real-daemon evaluation entry point is `pnpm eval:agent -- live`.
It sets runtime-owned `AYATI_EVALUATION_ID`, `AYATI_EVALUATION_NAME`,
`AYATI_EVALUATION_CAPTURE`, `AYATI_EVALUATION_ROOT`, and
`AYATI_EVALUATION_COMMAND` values for the spawned ordinary daemon. Do not set
these variables manually. Evaluation capture does not change `AYATI_ROOT_DIR`,
provider/model selection, prompts, tools, or daemon services.
