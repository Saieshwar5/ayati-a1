import React, { useState, useCallback } from "react";
import { Box, useApp } from "ink";
import { Header } from "./components/header.js";
import { MessageList } from "./components/message-list.js";
import { ChatInput } from "./components/chat-input.js";
import { StatusBar } from "./components/status-bar.js";
import { useWebSocket } from "./hooks/use-websocket.js";
import type { ChatMessage } from "./types.js";

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
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);

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

  return (
    <Box flexDirection="column" height={process.stdout.rows ?? 24}>
      <Header />
      <MessageList messages={messages} />
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
