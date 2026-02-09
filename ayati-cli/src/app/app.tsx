import React, { useState, useCallback, useEffect } from "react";
import { Box } from "ink";
import { Header } from "./components/header.js";
import { MessageList } from "./components/message-list.js";
import { ChatInput } from "./components/chat-input.js";
import { StatusBar } from "./components/status-bar.js";
import { useWebSocket } from "./hooks/use-websocket.js";
import type { ChatMessage } from "./types.js";

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
    const msg = data as { type?: string; content?: string };
    if (msg.type === "reply" && typeof msg.content === "string") {
      const reply = createMessage("assistant", msg.content);
      setMessages((prev) => [...prev, reply]);
      setIsLoading(false);
    }
  }, []);

  const { send, connected } = useWebSocket({ onMessage });

  const handleSubmit = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      if (!trimmed || isLoading) return;

      const userMessage = createMessage("user", trimmed);
      setMessages((prev) => [...prev, userMessage]);
      setInputValue("");

      setIsLoading(true);
      send({ type: "chat", content: trimmed });
    },
    [isLoading, send],
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
      <StatusBar isLoading={isLoading} connected={connected} />
      <ChatInput
        value={inputValue}
        onChange={setInputValue}
        onSubmit={handleSubmit}
        isLoading={isLoading}
      />
    </Box>
  );
}
