import React, { useState, useCallback, useEffect } from "react";
import { Box } from "ink";
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { Header } from "./components/header.js";
import { MessageList } from "./components/message-list.js";
import { ChatInput } from "./components/chat-input.js";
import { StatusBar } from "./components/status-bar.js";
import { useWebSocket } from "./hooks/use-websocket.js";
import { ATTACH_USAGE, parseCliCommand } from "./commands.js";
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

  const submitChatMessage = useCallback((
    content: string,
    attachments: ChatAttachment[],
    clearPendingAttachments = false,
  ) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    const attachmentNote = attachments.length > 0
      ? `\n\n[attached files: ${attachments.length}]`
      : "";
    const userMessage = createMessage("user", `${trimmed}${attachmentNote}`);
    setMessages((prev) => [...prev, userMessage]);

    setIsLoading(true);
    send({
      type: "chat",
      content: trimmed,
      ...(attachments.length > 0 ? { attachments } : {}),
    });

    if (clearPendingAttachments) {
      setPendingAttachments([]);
    }
  }, [send]);

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
          submitChatMessage,
          isLoading,
        });
        setInputValue("");
        return;
      }

      if (isLoading) return;
      setInputValue("");

      submitChatMessage(trimmed, pendingAttachments, pendingAttachments.length > 0);
    },
    [isLoading, pendingAttachments, submitChatMessage],
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
  submitChatMessage: (
    content: string,
    attachments: ChatAttachment[],
    clearPendingAttachments?: boolean,
  ) => void;
  isLoading: boolean;
}

function handleCommand(command: string, context: CommandContext): void {
  const parsed = parseCliCommand(command);

  if (parsed.type === "files") {
    if (context.pendingAttachments.length === 0) {
      context.pushAssistantMessage("No files queued. Use /attach <path> or /attach <path> -- <message>.");
      return;
    }

    const lines = ["Queued attachments:"];
    context.pendingAttachments.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry.path}`);
    });
    context.pushAssistantMessage(lines.join("\n"));
    return;
  }

  if (parsed.type === "clearfiles") {
    context.setPendingAttachments([]);
    context.pushAssistantMessage("Cleared all queued attachments.");
    return;
  }

  if (parsed.type === "invalid") {
    context.pushAssistantMessage(parsed.message);
    return;
  }

  if (parsed.type === "attach") {
    const absolutePath = resolve(parsed.rawPath);
    if (!existsSync(absolutePath)) {
      context.pushAssistantMessage(`File not found: ${absolutePath}`);
      return;
    }

    const attachment = {
      path: absolutePath,
      name: basename(absolutePath),
    };

    if (parsed.content) {
      if (context.isLoading) {
        context.pushAssistantMessage("Ayati is still responding. Wait for the current reply before sending another file+message.");
        return;
      }

      const attachments = mergeAttachments(context.pendingAttachments, attachment);
      context.submitChatMessage(parsed.content, attachments, context.pendingAttachments.length > 0);
      return;
    }

    if (context.pendingAttachments.some((entry) => entry.path === absolutePath)) {
      context.pushAssistantMessage(`Attachment already queued: ${absolutePath}`);
      return;
    }

    context.setPendingAttachments((prev) => mergeAttachments(prev, attachment));
    context.pushAssistantMessage(`Queued attachment: ${absolutePath}`);
    return;
  }

  context.pushAssistantMessage(`Unknown command. Use ${ATTACH_USAGE}, /files, or /clearfiles.`);
}

function mergeAttachments(
  existing: ChatAttachment[],
  nextAttachment: ChatAttachment,
): ChatAttachment[] {
  const merged = new Map(existing.map((attachment) => [attachment.path, attachment]));
  merged.set(nextAttachment.path, nextAttachment);
  return [...merged.values()];
}
