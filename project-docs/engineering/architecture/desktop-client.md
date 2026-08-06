# Electron Desktop Client

`ayati-desktop` is Ayati's resident graphical communication surface. It gives
the user a streaming chat window, keeps a daemon connection alive while the app
runs, minimizes to the system tray, and raises native notifications for replies
that arrive while the window is not focused.

It is intentionally a client, not a second agent runtime.

```text
React renderer
  -> typed preload bridge
  -> Electron main process
  -> WebSocket
  -> ayati-main daemon
  -> existing context -> decision -> action -> verification -> reducer loop
```

The daemon remains the only owner of context, tools, providers, memory,
workstreams, requests, durable messages, and finalization.

## Process Ownership

### Main process

The trusted Electron main process owns:

- the reconnecting daemon WebSocket;
- `client_hello` negotiation as client kind `desktop`;
- UUID creation for outgoing chat messages;
- validation of renderer IPC arguments;
- the application window, single-instance lifecycle, tray, and native
  notifications;
- forwarding validated daemon envelopes to the renderer.

### Preload bridge

The context-isolated preload exposes only:

- `getConnectionState()`;
- `sendChat({ content })`;
- `acknowledgeReplyRendered({ turnId, renderedAt })`;
- `onEvent(listener)` with an unsubscribe function.

The preload installs its IPC listener before renderer code runs and retains up
to 100 early events until the React application subscribes. This prevents the
startup connection transition or an immediate daemon notification from being
lost between page load and the first React effect.

Do not expose `ipcRenderer`, Electron objects, filesystem APIs, environment
variables, or a generic invoke/send function to the renderer.

### Renderer

The sandboxed React renderer owns ephemeral presentation state: the draft,
visible messages, bounded progress lines, queue position, and connection badge.
It cannot open the daemon socket itself and does not persist authoritative
conversation history.

## Message Flow

1. Start `ayati-main`; it listens on loopback port 8080 by default.
2. Launch `ayati-desktop`. Its main process loads the local renderer bundle,
   creates the tray, and starts the daemon connection.
3. On connection, the desktop sends `client_hello` with `clientKind=desktop`
   and `replyStreaming=true`.
4. When the user submits text, main-process IPC validation trims and bounds the
   content, creates a stable message UUID, and sends the ordinary `chat`
   envelope.
5. The renderer shows the user message and consumes `chat_accepted`, `progress`,
   `reply_started`, `reply_delta`, and `reply_done` envelopes. Legacy terminal
   reply, feedback, notification, and error envelopes remain renderable.
6. After a final streamed reply has painted, the renderer sends
   `reply_rendered`. The daemon can then finish its existing delivery
   acknowledgement path.
7. If the daemon restarts, the desktop moves to disconnected state and retries
   with a ten-second connection timeout and exponential backoff from one second
   up to 30 seconds.

Closing the window hides it when a tray is available. Use the tray's **Quit
desktop** action to stop the Electron client. This does not stop the daemon.

## Security Boundary

The desktop runtime uses the following controls:

- `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`;
- no `<webview>` and no renderer permission grants;
- a private `ayati://app` protocol instead of an HTTP development server or
  broad `file://` access;
- canonical-path and realpath containment before any renderer asset is served;
- a restrictive Content Security Policy with renderer networking disabled;
- denied popups, external navigation, permission requests, and permission
  checks;
- software rendering on Linux Wayland, where the client does not need GPU-heavy
  content and driver stability matters more than accelerated effects;
- sender-window and sender-URL validation for every IPC invocation;
- daemon-envelope parsing and bounded input at process boundaries;
- plaintext `ws:` accepted only for loopback hosts. Non-loopback configuration
  must use `wss:`.

Ayati does not yet have complete remote-client authentication and authorization.
Do not expose the daemon or point the desktop at an untrusted remote endpoint
just because `wss:` is accepted syntactically.

## Install and Run

Desktop development requires Node.js 22.12 or newer. Electron itself bundles
the Chromium and Node.js versions used at runtime.

From the repository root:

```bash
pnpm install
pnpm --filter ayati-desktop build
pnpm start:main
```

Then, from another terminal:

```bash
pnpm start:desktop
```

`start:desktop` runs the most recently built files. During development, rebuild
and launch in one command:

```bash
pnpm dev:desktop
```

Run the focused checks with:

```bash
pnpm --filter ayati-desktop test
pnpm --filter ayati-desktop build
```

## Configuration

The default connection is `ws://127.0.0.1:8080`. Override it in the environment
that launches Electron:

```bash
AYATI_DESKTOP_WS_URL=ws://127.0.0.1:9000 pnpm start:desktop
```

The first release deliberately does not duplicate attachment handling, durable
history storage, voice recording, model settings, tool policy, or daemon
lifecycle controls inside Electron. Existing push-to-talk voice remains a
daemon-owned channel controlled through the CLI shortcut. Future desktop
features should extend narrow typed contracts while preserving this process
boundary.
