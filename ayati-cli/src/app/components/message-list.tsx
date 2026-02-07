import React from "react";
import { Box, Text } from "ink";
import type { ChatMessage } from "../types.js";

type Props = {
  readonly messages: ChatMessage[];
};

function MessageBubble({
  message,
}: {
  readonly message: ChatMessage;
}): React.JSX.Element {
  const isUser = message.role === "user";

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={isUser ? "green" : "cyan"}>
        {isUser ? "You" : "Ayati"}
      </Text>
      <Box marginLeft={2}>
        <Text wrap="wrap">{message.content}</Text>
      </Box>
    </Box>
  );
}

export function MessageList({ messages }: Props): React.JSX.Element {
  if (messages.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" flexGrow={1}>
        <Text dimColor>No messages yet. Start typing below.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {messages.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}
    </Box>
  );
}
