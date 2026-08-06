import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type {
  DaemonConnectionState,
  DesktopEvent,
  ReplyDoneMessage,
} from "../shared/contracts.js";
import {
  initialChatState,
  reduceChatState,
  type ChatViewMessage,
} from "./chat-state.js";

const INITIAL_CONNECTION: DaemonConnectionState = {
  status: "disconnected",
  changedAt: new Date(0).toISOString(),
  detail: "Waiting for desktop runtime…",
};

export function App(): React.JSX.Element {
  const [connection, setConnection] = useState(INITIAL_CONNECTION);
  const [chat, dispatch] = useReducer(reduceChatState, initialChatState);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const acknowledgedTurnsRef = useRef(new Set<string>());

  useEffect(() => {
    let disposed = false;
    const unsubscribe = window.ayati.onEvent((event) => {
      if (disposed) return;
      handleDesktopEvent(event, setConnection, dispatch);
      if (event.type === "server_message" && event.message.type === "reply_done") {
        acknowledgeAfterPaint(event.message, acknowledgedTurnsRef.current);
      }
    });
    void window.ayati.getConnectionState().then((state) => {
      if (!disposed) setConnection(state);
    }, (error: unknown) => {
      if (!disposed) {
        setConnection({
          status: "disconnected",
          changedAt: new Date().toISOString(),
          detail: formatError(error),
        });
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.messages, chat.progressLines]);

  const submit = async (): Promise<void> => {
    const content = draft.trim();
    if (!content || submitting || connection.status !== "connected") return;
    setSubmitting(true);
    try {
      const receipt = await window.ayati.sendChat({ content });
      dispatch({ type: "chat_submitted", content, receipt });
      setDraft("");
    } catch (error) {
      dispatch({
        type: "submission_failed",
        message: formatError(error),
        receivedAt: new Date().toISOString(),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void submit();
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  const sendDisabled = connection.status !== "connected" || draft.trim().length === 0 || submitting;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <div className="brand-name">AYATI</div>
            <div className="brand-subtitle">DESKTOP CHANNEL</div>
          </div>
        </div>
        <ConnectionBadge state={connection} />
      </header>

      <section className="conversation" aria-label="Conversation">
        {chat.messages.length === 0 ? <EmptyState connected={connection.status === "connected"} /> : null}
        <div className="message-list" aria-live="polite">
          {chat.messages.map((message) => <Message key={message.id} message={message} />)}
          {chat.queuePosition !== undefined ? (
            <div className="activity-card queued">
              <span className="activity-pulse" />
              Queued at position {chat.queuePosition}
            </div>
          ) : null}
          {chat.progressLines.length > 0 ? (
            <div className="progress-card">
              <div className="progress-title">
                <span className="activity-pulse" />
                Ayati is working
              </div>
              <ol>
                {chat.progressLines.map((line, index) => <li key={`${index}:${line}`}>{line}</li>)}
              </ol>
            </div>
          ) : null}
          {chat.isAgentActive && chat.progressLines.length === 0 && chat.queuePosition === undefined ? (
            <div className="thinking-row" aria-label="Ayati is thinking">
              <span /><span /><span />
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>
      </section>

      <footer className="composer-wrap">
        {connection.status !== "connected" ? (
          <div className="connection-warning">
            {connection.detail ?? "Start the Ayati daemon to begin."}
          </div>
        ) : null}
        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            aria-label="Message Ayati"
            placeholder={connection.status === "connected" ? "Message Ayati…" : "Waiting for daemon…"}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            disabled={connection.status !== "connected"}
            rows={1}
          />
          <button type="submit" disabled={sendDisabled} aria-label="Send message">
            {submitting ? <span className="button-spinner" /> : <ArrowIcon />}
          </button>
        </form>
        <div className="composer-hint">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span>Voice remains available through your Ayati push-to-talk shortcut</span>
        </div>
      </footer>
    </main>
  );
}

function handleDesktopEvent(
  event: DesktopEvent,
  setConnection: (state: DaemonConnectionState) => void,
  dispatch: React.Dispatch<Parameters<typeof reduceChatState>[1]>,
): void {
  if (event.type === "connection_state") {
    setConnection(event.state);
    return;
  }
  dispatch({
    type: "server_message",
    message: event.message,
    receivedAt: new Date().toISOString(),
  });
}

function acknowledgeAfterPaint(message: ReplyDoneMessage, acknowledgedTurns: Set<string>): void {
  if (acknowledgedTurns.has(message.turnId)) return;
  acknowledgedTurns.add(message.turnId);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      void window.ayati.acknowledgeReplyRendered({
        turnId: message.turnId,
        renderedAt: new Date().toISOString(),
      }).catch((error: unknown) => {
        acknowledgedTurns.delete(message.turnId);
        console.warn("Could not acknowledge rendered Ayati reply:", error);
      });
    });
  });
}

function ConnectionBadge({ state }: { state: DaemonConnectionState }): React.JSX.Element {
  const label = state.status === "connected"
    ? "Daemon connected"
    : state.status === "connecting"
      ? "Connecting"
      : "Disconnected";
  return (
    <div className={`connection-badge ${state.status}`} title={state.detail}>
      <span className="connection-dot" />
      {label}
    </div>
  );
}

function EmptyState({ connected }: { connected: boolean }): React.JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-orbit"><span /></div>
      <p className="eyebrow">YOUR LOCAL AGENT</p>
      <h1>{connected ? "What should we work on?" : "Waiting for Ayati"}</h1>
      <p>
        {connected
          ? "This desktop is a secure communication surface. The daemon keeps ownership of context, tools, memory, and durable work."
          : "Start the daemon and this client will reconnect automatically."}
      </p>
    </div>
  );
}

function Message({ message }: { message: ChatViewMessage }): React.JSX.Element {
  const label = message.role === "user"
    ? "You"
    : message.kind === "feedback"
      ? "Ayati · input needed"
      : message.kind === "notification"
        ? "Ayati · notification"
        : message.kind === "error"
          ? "Desktop"
          : "Ayati";
  return (
    <article className={`message ${message.role} ${message.kind}`}>
      <div className="message-meta">
        <span>{label}</span>
        <time>{formatTime(message.timestamp)}</time>
      </div>
      <div className="message-content">
        {message.content || (message.streaming ? "Thinking" : "")}
        {message.streaming ? <span className="streaming-cursor" /> : null}
      </div>
      {message.commitStatus ? (
        <div className={`commit-status ${message.commitStatus}`}>{formatCommitStatus(message.commitStatus)}</div>
      ) : null}
    </article>
  );
}

function ArrowIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)
    : "";
}

function formatCommitStatus(value: string): string {
  return value.replaceAll("_", " ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
