import React from "react";
import { Box, Text } from "ink";

export function Header(): React.JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
      justifyContent="center"
    >
      <Text bold color="cyan">
        Ayati
      </Text>
      <Text dimColor> v1.0.0</Text>
    </Box>
  );
}
