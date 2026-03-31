import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Box, Text, useInput } from "ink";
import type { ChatMessage } from "../types.js";
import {
  formatAssistantMessage,
  type DisplayLine,
  type DisplaySegment,
} from "./assistant-message-formatter.js";
import {
  clamp,
  resolveScrollTopAfterContentChange,
  scrollByLines,
  scrollByPages,
} from "./message-list-scroll.js";

type Props = {
  readonly messages: ChatMessage[];
  readonly height: number;
  readonly width: number;
};

export type MessageListHandle = {
  readonly scrollByLines: (delta: number) => void;
  readonly scrollByPages: (pageDelta: number) => void;
  readonly scrollToTop: () => void;
  readonly scrollToBottom: () => void;
};

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
    const assistantPresentation = message.kind === "feedback"
      ? { label: "Ayati [feedback]", color: "yellow" as const }
      : message.kind === "notification"
        ? { label: "Ayati [notification]", color: "magenta" as const }
        : message.kind === "error"
          ? { label: "Ayati [error]", color: "red" as const }
          : { label: "Ayati", color: "cyan" as const };

    lines.push({
      segments: [{
        text: isUser ? "You" : assistantPresentation.label,
        bold: true,
        color: isUser ? "green" : assistantPresentation.color,
      }],
    });

    if (isUser) {
      const wrappedLines = wrapContent(message.content, contentWidth);
      for (const line of wrappedLines) {
        lines.push({
          segments: [{ text: `  ${line}` }],
        });
      }
    } else {
      lines.push(...formatAssistantMessage({
        content: message.content,
        width: contentWidth,
        assistantColor: assistantPresentation.color,
      }));
    }

    lines.push({ segments: [] });
  }

  return lines;
}

function renderSegments(segments: DisplaySegment[], lineKey: string): React.JSX.Element {
  if (segments.length === 0) {
    return <Text key={`${lineKey}-empty`}> </Text>;
  }

  return (
    <>
      {segments.map((segment, segmentIndex) => (
        <Text
          key={`${lineKey}-${segmentIndex}`}
          color={segment.color}
          backgroundColor={segment.backgroundColor}
          dimColor={segment.dimColor}
          bold={segment.bold}
          italic={segment.italic}
          underline={segment.underline}
          inverse={segment.inverse}
          strikethrough={segment.strikethrough}
        >
          {segment.text}
        </Text>
      ))}
    </>
  );
}

export const MessageList = forwardRef<MessageListHandle, Props>(function MessageList(
  { messages, height, width },
  ref,
): React.JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);

  const lines = useMemo(() => toDisplayLines(messages, width), [messages, width]);

  const viewportHeight = Math.max(1, height);
  const maxScrollTop = Math.max(0, lines.length - viewportHeight);
  const previousMaxRef = useRef(0);

  const handleScrollByLines = useCallback((delta: number) => {
    if (lines.length === 0) {
      return;
    }

    setScrollTop((value) => scrollByLines(value, delta, maxScrollTop));
  }, [lines.length, maxScrollTop]);

  const handleScrollByPages = useCallback((pageDelta: number) => {
    if (lines.length === 0) {
      return;
    }

    setScrollTop((value) => scrollByPages(value, pageDelta, viewportHeight, maxScrollTop));
  }, [lines.length, maxScrollTop, viewportHeight]);

  const handleScrollToTop = useCallback(() => {
    setScrollTop(0);
  }, []);

  const handleScrollToBottom = useCallback(() => {
    setScrollTop(maxScrollTop);
  }, [maxScrollTop]);

  useImperativeHandle(ref, () => ({
    scrollByLines: handleScrollByLines,
    scrollByPages: handleScrollByPages,
    scrollToTop: handleScrollToTop,
    scrollToBottom: handleScrollToBottom,
  }), [
    handleScrollByLines,
    handleScrollByPages,
    handleScrollToTop,
    handleScrollToBottom,
  ]);

  useEffect(() => {
    setScrollTop((value) => resolveScrollTopAfterContentChange({
      scrollTop: value,
      previousMaxScrollTop: previousMaxRef.current,
      nextMaxScrollTop: maxScrollTop,
    }));
    previousMaxRef.current = maxScrollTop;
  }, [maxScrollTop]);

  useInput((_, key) => {
    if (lines.length === 0) {
      return;
    }

    if (key.upArrow) {
      handleScrollByLines(-1);
      return;
    }

    if (key.downArrow) {
      handleScrollByLines(1);
      return;
    }

    if (key.pageUp) {
      handleScrollByPages(-1);
      return;
    }

    if (key.pageDown) {
      handleScrollByPages(1);
      return;
    }

    if (key.home) {
      handleScrollToTop();
      return;
    }

    if (key.end) {
      handleScrollToBottom();
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
        <Box key={`${start}-${index}`}>
          {renderSegments(line.segments, `${start}-${index}`)}
        </Box>
      ))}
    </Box>
  );
});
