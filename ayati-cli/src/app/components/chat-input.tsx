import React from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly isLoading: boolean;
};

export function ChatInput({
  value,
  onChange,
  onSubmit,
  isLoading,
}: Props): React.JSX.Element {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text color="green" bold>
        {">"}{" "}
      </Text>
      <TextInput
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        placeholder="Type a message or /attach <path>"
        focus={!isLoading}
        showCursor
      />
    </Box>
  );
}
