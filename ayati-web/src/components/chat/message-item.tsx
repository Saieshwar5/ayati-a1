import type { ChatMessage } from "@/lib/chat/types";
import { MarkdownMessage } from "./markdown-message";
import { MessageArtifacts } from "./message-artifacts";

interface MessageItemProps {
  message: ChatMessage;
}

const TIME_FORMATTER = new Intl.DateTimeFormat("en", {
  hour: "numeric",
  minute: "2-digit",
});

const MESSAGE_META = {
  user: {
    align: "justify-end",
    bubble:
      "max-w-[72%] rounded-2xl rounded-br-md border border-black/5 bg-[color:var(--app-user-bubble)] text-[color:var(--app-user-foreground)]",
  },
  reply: {
    align: "justify-start",
    bubble:
      "max-w-[92%] rounded-2xl rounded-bl-md border border-black/8 bg-[color:var(--app-assistant-bubble)] text-[color:var(--app-foreground)]",
  },
  feedback: {
    align: "justify-start",
    bubble:
      "max-w-[92%] rounded-2xl rounded-bl-md border border-[color:var(--app-accent-soft)] bg-[color:var(--app-assistant-bubble)] text-[color:var(--app-foreground)]",
  },
  notification: {
    align: "justify-start",
    bubble:
      "max-w-[92%] rounded-2xl rounded-bl-md border border-amber-200 bg-[color:var(--app-system-bubble)] text-[color:var(--app-foreground)]",
  },
  error: {
    align: "justify-start",
    bubble:
      "max-w-[92%] rounded-2xl rounded-bl-md border border-rose-200 bg-[color:var(--app-error-bubble)] text-rose-800",
  },
} as const;

export function MessageItem({ message }: MessageItemProps) {
  const meta = MESSAGE_META[message.kind];
  const rendersMarkdown = message.kind === "reply" || message.kind === "feedback";
  const hasArtifacts = (message.artifacts?.length ?? 0) > 0;

  return (
    <article className="space-y-2">
      <div className={`flex w-full ${meta.align}`}>
        <div
          className={`space-y-3 whitespace-pre-wrap px-4 py-3 text-sm leading-7 shadow-sm shadow-slate-950/5 sm:text-[15px] ${meta.bubble}`}
        >
          {rendersMarkdown ? <MarkdownMessage content={message.content} /> : message.content}
          {hasArtifacts ? <MessageArtifacts artifacts={message.artifacts ?? []} /> : null}
        </div>
      </div>

      <div className={`flex w-full ${meta.align}`}>
        <time
          className="px-1 text-xs font-medium text-[color:var(--app-muted)]"
          dateTime={new Date(message.timestamp).toISOString()}
        >
          {TIME_FORMATTER.format(message.timestamp)}
        </time>
      </div>
    </article>
  );
}
