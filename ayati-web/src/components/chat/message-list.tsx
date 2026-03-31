"use client";

import { useEffect, useRef } from "react";
import type { ChatMessage, ConnectionState } from "@/lib/chat/types";
import { MessageItem } from "./message-item";

interface MessageListProps {
  connectionState: ConnectionState;
  isAwaitingReply: boolean;
  messages: ChatMessage[];
}

export function MessageList({
  connectionState,
  isAwaitingReply,
  messages,
}: MessageListProps) {
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endOfMessagesRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [isAwaitingReply, messages]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center px-4 py-8">
        <div className="max-w-xl text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-full border border-[color:var(--app-border)] bg-white text-lg font-semibold text-[color:var(--app-muted)] shadow-sm shadow-slate-950/5">
            A
          </div>
          <h2 className="text-3xl font-semibold tracking-tight text-[color:var(--app-foreground)]">
            Start a conversation
          </h2>
          <p className="mt-3 text-sm leading-7 text-[color:var(--app-muted)]">
            Ask Ayati anything once the socket is connected. This stage stays
            text-only and focused on a clean chat flow.
          </p>
          <p className="mt-4 text-xs font-medium text-[color:var(--app-muted)]">
            Status: {connectionState}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-8 sm:px-6 sm:py-10">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}

      {isAwaitingReply ? (
        <div className="flex justify-start">
          <div className="rounded-2xl rounded-bl-md border border-black/8 bg-white px-4 py-3 shadow-sm shadow-slate-950/5">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-slate-400 animate-bounce" />
              <span
                className="h-2 w-2 rounded-full bg-slate-400 animate-bounce"
                style={{ animationDelay: "0.1s" }}
              />
              <span
                className="h-2 w-2 rounded-full bg-slate-400 animate-bounce"
                style={{ animationDelay: "0.2s" }}
              />
            </div>
          </div>
        </div>
      ) : null}

      <div ref={endOfMessagesRef} />
    </div>
  );
}
