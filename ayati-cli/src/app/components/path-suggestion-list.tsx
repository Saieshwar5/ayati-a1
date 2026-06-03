import React from "react";
import { Box, Text } from "ink";
import type { PathSuggestion } from "../path-suggestions.js";

type Props = {
  readonly suggestions: PathSuggestion[];
  readonly selectedIndex: number;
  readonly height: number;
};

export function PathSuggestionList({
  suggestions,
  selectedIndex,
  height,
}: Props): React.JSX.Element | null {
  if (suggestions.length === 0 || height <= 0) {
    return null;
  }

  const visibleSuggestions = suggestions.slice(0, Math.max(0, height - 1));

  return (
    <Box flexDirection="column" paddingX={1} height={height}>
      <Text dimColor>@path suggestions</Text>
      {visibleSuggestions.map((suggestion, index) => {
        const selected = index === selectedIndex;
        return (
          <Text key={suggestion.path} inverse={selected}>
            <Text color={suggestion.kind === "directory" ? "cyan" : "green"}>
              {suggestion.kind === "directory" ? "dir " : "file"}
            </Text>{" "}
            <Text>{suggestion.name}</Text>{" "}
            <Text dimColor>{suggestion.displayPath}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function pathSuggestionHeight(suggestions: PathSuggestion[]): number {
  if (suggestions.length === 0) {
    return 0;
  }

  return Math.min(7, suggestions.length + 1);
}
