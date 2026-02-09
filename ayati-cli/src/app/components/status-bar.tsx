import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

type Props = {
  readonly isLoading: boolean;
  readonly connected?: boolean;
};

export function StatusBar({ isLoading, connected }: Props): React.JSX.Element {
  return (
    <Box paddingX={1} height={1}>
      {isLoading ? (
        <Text color="yellow">
          <Spinner type="dots" /> Ayati is thinking...
        </Text>
      ) : (
        <Text dimColor>
          {connected === false ? "[disconnected] " : ""}
          Enter: send | Up/Down/PgUp/PgDn: scroll | Ctrl+C: exit
        </Text>
      )}
    </Box>
  );
}
