import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

type Props = {
  readonly isLoading: boolean;
  readonly connected?: boolean;
  readonly pendingAttachmentCount?: number;
};

export function StatusBar({ isLoading, connected, pendingAttachmentCount }: Props): React.JSX.Element {
  const attachmentLabel = pendingAttachmentCount && pendingAttachmentCount > 0
    ? ` | Files queued: ${pendingAttachmentCount}`
    : "";

  return (
    <Box paddingX={1} height={1}>
      {isLoading ? (
        <Text color="yellow">
          <Spinner type="dots" /> Ayati is thinking...
        </Text>
      ) : (
        <Text dimColor>
          {connected === false ? "[disconnected] " : ""}
          Enter: send | /attach /files /clearfiles | Up/Down/PgUp/PgDn: scroll | Ctrl+C: exit{attachmentLabel}
        </Text>
      )}
    </Box>
  );
}
