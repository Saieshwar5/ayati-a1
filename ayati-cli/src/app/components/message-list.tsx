import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ChatMessage } from "../types.js";

type Props = {
  readonly messages: ChatMessage[];
  readonly height: number;
  readonly width: number;
};

type DisplayLine = {
  readonly text: string;
  readonly color?: "green" | "cyan";
  readonly bold?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function wrapSegment(segment: string, width: number): string[] {
  if (segment.length === 0) {
    return [""];
  }

  const words = segment.split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (word.length === 0) {
      continue;
    }

    if (current.length === 0) {
      if (word.length <= width) {
        current = word;
      } else {
        for (let index = 0; index < word.length; index += width) {
          lines.push(word.slice(index, index + width));
        }
      }
      continue;
    }

    const candidate = `${current} ${word}`;

    if (candidate.length <= width) {
      current = candidate;
      continue;
    }

    lines.push(current);

    if (word.length <= width) {
      current = word;
    } else {
      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }
      current = "";
    }
  }

  if (current.length > 0) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function wrapContent(content: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const rawLines = content.split(/\r?\n/);
  const wrapped: string[] = [];

  for (const rawLine of rawLines) {
    wrapped.push(...wrapSegment(rawLine, safeWidth));
  }

  return wrapped;
}

function toDisplayLines(messages: ChatMessage[], width: number): DisplayLine[] {
  const contentWidth = Math.max(1, width - 2);
  const lines: DisplayLine[] = [];

  for (const message of messages) {
    const isUser = message.role === "user";

    lines.push({
      text: isUser ? "You" : "Ayati",
      bold: true,
      color: isUser ? "green" : "cyan",
    });

    const wrappedLines = wrapContent(message.content, contentWidth);
    for (const line of wrappedLines) {
      lines.push({ text: `  ${line}` });
    }

    lines.push({ text: "" });
  }

  return lines;
}

export function MessageList({ messages, height, width }: Props): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);

  const lines = useMemo(() => toDisplayLines(messages, width), [messages, width]);

  const viewportHeight = Math.max(1, height);
  const maxScrollTop = Math.max(0, lines.length - viewportHeight);
  const previousMaxRef = useRef(0);

  useEffect(() => {
    const previousMax = previousMaxRef.current;
    const wasAtBottom = scrollTop >= previousMax;

    if (wasAtBottom) {
      if (scrollTop !== maxScrollTop) {
        setScrollTop(maxScrollTop);
      }
    } else if (scrollTop > maxScrollTop) {
      setScrollTop(maxScrollTop);
    }

    previousMaxRef.current = maxScrollTop;
  }, [maxScrollTop, scrollTop]);

  useInput((_, key) => {
    if (lines.length === 0) {
      return;
    }

    if (key.upArrow) {
      setScrollTop((value) => clamp(value - 1, 0, maxScrollTop));
      return;
    }

    if (key.downArrow) {
      setScrollTop((value) => clamp(value + 1, 0, maxScrollTop));
      return;
    }

    if (key.pageUp) {
      setScrollTop((value) => clamp(value - viewportHeight, 0, maxScrollTop));
      return;
    }

    if (key.pageDown) {
      setScrollTop((value) => clamp(value + viewportHeight, 0, maxScrollTop));
      return;
    }

    if (key.home) {
      setScrollTop(0);
      return;
    }

    if (key.end) {
      setScrollTop(maxScrollTop);
    }
  });

  if (messages.length === 0) {
    return (
      <Box justifyContent="center" alignItems="center" height={viewportHeight}>
        <Text dimColor>No messages yet. Start typing below.</Text>
      </Box>
    );
  }

  const start = clamp(scrollTop, 0, maxScrollTop);
  const visibleLines = lines.slice(start, start + viewportHeight);

  return (
    <Box flexDirection="column" paddingX={1} height={viewportHeight}>
      {visibleLines.map((line, index) => (
        <Text key={`${start}-${index}`} color={line.color} bold={line.bold}>
          {line.text.length > 0 ? line.text : " "}
        </Text>
      ))}
    </Box>
  );
}
