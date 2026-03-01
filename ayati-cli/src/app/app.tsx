import React, { useState, useCallback, useEffect } from "react";
import { Box } from "ink";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Header } from "./components/header.js";
import { MessageList } from "./components/message-list.js";
import { ChatInput } from "./components/chat-input.js";
import { StatusBar } from "./components/status-bar.js";
import { useWebSocket } from "./hooks/use-websocket.js";
import type { ChatAttachment, ChatMessage, ServerMessage } from "./types.js";

const HEADER_HEIGHT = 3;
const STATUS_HEIGHT = 1;
const INPUT_HEIGHT = 3;
const RESERVED_ROWS = HEADER_HEIGHT + STATUS_HEIGHT + INPUT_HEIGHT;
const MIN_TERMINAL_ROWS = 10;
const MIN_MESSAGE_ROWS = 3;
const MIN_TERMINAL_COLUMNS = 20;

let nextId = 1;

function createMessage(
  role: ChatMessage["role"],
  content: string,
): ChatMessage {
  return {
    id: String(nextId++),
    role,
    content,
    timestamp: Date.now(),
  };
}

export function App(): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<ChatAttachment[]>([]);
  const [terminalRows, setTerminalRows] = useState(
    Math.max(process.stdout.rows ?? 24, MIN_TERMINAL_ROWS),
  );
  const [terminalColumns, setTerminalColumns] = useState(
    Math.max(process.stdout.columns ?? 80, MIN_TERMINAL_COLUMNS),
  );

  useEffect(() => {
    const handleResize = (): void => {
      setTerminalRows(Math.max(process.stdout.rows ?? 24, MIN_TERMINAL_ROWS));
      setTerminalColumns(
        Math.max(process.stdout.columns ?? 80, MIN_TERMINAL_COLUMNS),
      );
    };

    process.stdout.on("resize", handleResize);

    return () => {
      process.stdout.off("resize", handleResize);
    };
  }, []);

  const onMessage = useCallback((data: unknown) => {
    const msg = data as ServerMessage | { type?: string; content?: string };
    if (msg.type === "reply" && typeof msg.content === "string") {
      const reply = createMessage("assistant", msg.content);
      setMessages((prev) => [...prev, reply]);
      setIsLoading(false);
      return;
    }

    if (msg.type === "error" && typeof msg.content === "string") {
      const reply = createMessage("assistant", `[error] ${msg.content}`);
      setMessages((prev) => [...prev, reply]);
      setIsLoading(false);
    }
  }, []);

  const { send, connected } = useWebSocket({ onMessage });

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("/")) {
        handleCommand(trimmed, {
          pendingAttachments,
          setPendingAttachments,
          pushAssistantMessage: (content) => {
            setMessages((prev) => [...prev, createMessage("assistant", content)]);
          },
        });
        setInputValue("");
        return;
      }

      if (isLoading) return;

      const attachmentNote = pendingAttachments.length > 0
        ? `\n\n[attached files: ${pendingAttachments.length}]`
        : "";
      const userMessage = createMessage("user", `${trimmed}${attachmentNote}`);
      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");

      setIsLoading(true);
      send({
        type: "chat",
        content: trimmed,
        ...(pendingAttachments.length > 0 ? { attachments: pendingAttachments } : {}),
      });
      if (pendingAttachments.length > 0) {
        setPendingAttachments([]);
      }
    },
    [isLoading, pendingAttachments, send],
  );

  const messageViewportHeight = Math.max(
    MIN_MESSAGE_ROWS,
    terminalRows - RESERVED_ROWS,
  );

  return (
    <Box flexDirection="column" height={terminalRows}>
      <Header />
      <MessageList
        messages={messages}
        height={messageViewportHeight}
        width={terminalColumns - 2}
      />
      <StatusBar
        isLoading={isLoading}
        connected={connected}
        pendingAttachmentCount={pendingAttachments.length}
      />
      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isLoading={isLoading}
      />
    </Box>
  );
}

interface CommandContext {
  pendingAttachments: ChatAttachment[];
  setPendingAttachments: React.Dispatch<React.SetStateAction<ChatAttachment[]>>;
  pushAssistantMessage: (content: string) => void;
}

function handleCommand(command: string, context: CommandContext): void {
  const [name, ...rest] = command.split(" ");
  const normalized = (name ?? "").toLowerCase();
  const arg = rest.join(" ").trim();

  if (normalized === "/files") {
    if (context.pendingAttachments.length === 0) {
      context.pushAssistantMessage("No files queued. Use /attach <path> to add documents.");
      return;
    }

    const lines = ["Queued attachments:"];
    context.pendingAttachments.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.path}`);
    });
    context.pushAssistantMessage(lines.join("\n"));
    return;
  }

  if (normalized === "/clearfiles") {
    context.setPendingAttachments([]);
    context.pushAssistantMessage("Cleared all queued attachments.");
    return;
  }

  if (normalized === "/attach") {
    if (arg.length === 0) {
      context.pushAssistantMessage("Usage: /attach <local-file-path>");
      return;
    }

    const absolutePath = resolve(arg);
    if (!existsSync(absolutePath)) {
      context.pushAssistantMessage(`File not found: ${absolutePath}`);
      return;
    }

    context.setPendingAttachments((prev) => {
      if (prev.some((entry) => entry.path === absolutePath)) {
        return prev;
      }

      return [...prev, { path: absolutePath }];
    });
    context.pushAssistantMessage(`Queued attachment: ${absolutePath}`);
    return;
  }

  context.pushAssistantMessage("Unknown command. Use /attach <path>, /files, or /clearfiles.");
}
