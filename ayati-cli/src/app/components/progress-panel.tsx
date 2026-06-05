import React from "react";
import { Box, Text } from "ink";

export const MAX_PROGRESS_LINES = 5;

type Props = {
  readonly lines: string[];
  readonly width: number;
};

export function progressPanelHeight(lines: string[]): number {
  return lines.length > 0 ? Math.min(lines.length, MAX_PROGRESS_LINES) + 1 : 0;
}

export function ProgressPanel({ lines, width }: Props): React.JSX.Element | null {
  const visibleLines = lines.slice(-MAX_PROGRESS_LINES);
  if (visibleLines.length === 0) {
    return null;
  }

  const contentWidth = Math.max(12, width - 4);
  const latestIndex = visibleLines.length - 1;

  return (
    <Box flexDirection="column" paddingX={1} height={progressPanelHeight(visibleLines)}>
      <Text color="yellow" bold>Ayati is working</Text>
      {visibleLines.map((line, index) => {
        const latest = index === latestIndex;
        return (
          <Text key={`${index}-${line}`} color={latest ? "yellow" : undefined} dimColor={!latest}>
            {latest ? "> " : "  "}
            {truncateLine(line, contentWidth)}
          </Text>
        );
      })}
    </Box>
  );
}

function truncateLine(line: string, width: number): string {
  const normalized = line.replace(/\s+/g, " ").trim();
  if (normalized.length <= width) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, width - 3))}...`;
}
