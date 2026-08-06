# Voice Interface

Ayati voice input is a daemon-owned communication channel. It converts speech
to text before the agent harness sees it; raw audio is never sent to the model
or stored by Ayati.

## Runtime Flow

```text
push-to-talk key
  -> local Ayati control socket
  -> Voxtype recording and local Whisper transcription
  -> transcript review
  -> normalized chat ingress
  -> global agent run queue
  -> normal Context Engine and harness lifecycle
  -> desktop reply notification
```

The existing Voxtype OSD remains the recording/transcription UI. Ayati adds
review, queue, error, and reply notifications through `notify-send`. This keeps
microphone capture, model management, and waveform rendering in the mature
desktop component while keeping agent intelligence in the daemon.

## Interaction

Voice uses push-to-talk and confirmation by default:

1. Press and hold the configured Ayati voice key.
2. Speak while the Voxtype OSD is visible.
3. Release the key to transcribe.
4. Review the desktop transcript notification.
5. Press the voice key once more to send it to Ayati, or cancel it.

Set `AYATI_VOICE_AUTO_SEND=1` only when immediate sending is preferred over
review. Voice input shares the same default agent stream and serialized run
queue as terminal input. It does not create a second agent, memory, or harness.

## Control Commands

With `ayati-cli` built, the executable accepts:

```bash
node ayati-cli/dist/index.js voice status
node ayati-cli/dist/index.js voice press
node ayati-cli/dist/index.js voice release
node ayati-cli/dist/index.js voice send
node ayati-cli/dist/index.js voice cancel
node ayati-cli/dist/index.js voice toggle
```

`start` and `stop` are aliases for `press` and `release`. The commands talk to
the daemon over a user-only Unix socket at
`$XDG_RUNTIME_DIR/ayati/voice.sock`; they do not start a second daemon.

## Ownership and Reliability

- Voxtype owns microphone capture, its local Whisper model, and the active OSD.
- `VoiceChannelRuntime` owns the Ayati voice state machine and temporary
  transcript lifecycle.
- `VoiceControlServer` owns the private local command socket.
- `IVecEngine` owns queue admission and duplicate message-ID suppression.
- The Context Engine owns the immutable accepted text and normal run lifecycle
  once that queued chat begins preparation.

Each recording uses a unique file under
`$XDG_RUNTIME_DIR/ayati/voice-transcripts/`. Directories are mode `0700` and
the transcript file is created mode `0600`. Ayati passes the path to Voxtype as
an argument, never through a shell, validates transcript size, and deletes the
file after chat acceptance or cancellation. Daemon shutdown cancels only the
recording started by Ayati; it does not stop the shared Voxtype service.

Each normalized chat has a stable `messageId`. Replies carry the same ID and
are routed to the exact originating client, while logical ownership remains
the local user. The existing agent queue is process-local; clean shutdown
drains it, but crash-durable generic chat ingress remains a separate future
transport improvement.

## Failure Behavior

Voice is fail-soft. If Voxtype, its user daemon, or desktop notifications are
unavailable, the main agent daemon and terminal client still run. Use:

```bash
pnpm doctor:main
node ayati-cli/dist/index.js voice status
```

Ayati refuses to take over Voxtype when another dictation recording is already
active. Empty speech, oversized transcripts, transcription timeouts, and
unreachable control sockets produce explicit state and notification errors.
