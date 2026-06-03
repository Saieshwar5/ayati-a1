import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";

type Props = {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (value: string) => void;
  readonly isLoading: boolean;
  readonly width?: number;
  readonly height?: number;
  readonly suggestionsVisible?: boolean;
  readonly onSuggestionUp?: () => void;
  readonly onSuggestionDown?: () => void;
  readonly onAcceptSuggestion?: (options?: { finalizeDirectory?: boolean }) => void;
  readonly onDismissSuggestions?: () => void;
};

type WrappedRow = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 5;
const MIN_CONTENT_WIDTH = 8;

export function ChatInput({
  value,
  onChange,
  onSubmit,
  isLoading,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  suggestionsVisible = false,
  onSuggestionUp,
  onSuggestionDown,
  onAcceptSuggestion,
  onDismissSuggestions,
}: Props): React.JSX.Element {
  const [cursorOffset, setCursorOffset] = useState(value.length);
  const lastLocalValueRef = useRef(value);

  useEffect(() => {
    if (lastLocalValueRef.current !== value) {
      setCursorOffset(value.length);
      lastLocalValueRef.current = value;
      return;
    }

    setCursorOffset((offset) => clamp(offset, 0, value.length));
  }, [value]);

  const contentHeight = Math.max(1, height - 2);
  const contentWidth = Math.max(MIN_CONTENT_WIDTH, width - 6);

  const updateValue = (nextValue: string, nextCursorOffset: number): void => {
    const clampedCursor = clamp(nextCursorOffset, 0, nextValue.length);
    lastLocalValueRef.current = nextValue;
    setCursorOffset(clampedCursor);
    onChange(nextValue);
  };

  useInput((input, key) => {
    if (isLoading) {
      return;
    }

    if (suggestionsVisible) {
      if (key.upArrow) {
        onSuggestionUp?.();
        return;
      }

      if (key.downArrow) {
        onSuggestionDown?.();
        return;
      }

      if (key.tab) {
        onAcceptSuggestion?.();
        return;
      }

      if (key.return) {
        onAcceptSuggestion?.({ finalizeDirectory: true });
        return;
      }

      if (key.escape) {
        onDismissSuggestions?.();
        return;
      }
    }

    if (key.return) {
      onSubmit(value);
      return;
    }

    if (key.ctrl && input === "c") {
      return;
    }

    if (key.ctrl && input === "a") {
      setCursorOffset(0);
      return;
    }

    if (key.ctrl && input === "e") {
      setCursorOffset(value.length);
      return;
    }

    if (key.ctrl && input === "u") {
      updateValue(value.slice(cursorOffset), 0);
      return;
    }

    if (key.ctrl && input === "k") {
      updateValue(value.slice(0, cursorOffset), cursorOffset);
      return;
    }

    if (key.ctrl && input === "w") {
      const start = findPreviousWordStart(value, cursorOffset);
      updateValue(value.slice(0, start) + value.slice(cursorOffset), start);
      return;
    }

    if (key.leftArrow) {
      setCursorOffset((offset) => clamp(offset - 1, 0, value.length));
      return;
    }

    if (key.rightArrow) {
      setCursorOffset((offset) => clamp(offset + 1, 0, value.length));
      return;
    }

    if (key.home) {
      setCursorOffset(0);
      return;
    }

    if (key.end) {
      setCursorOffset(value.length);
      return;
    }

    if (key.backspace || key.delete) {
      if (cursorOffset > 0) {
        updateValue(
          value.slice(0, cursorOffset - 1) + value.slice(cursorOffset),
          cursorOffset - 1,
        );
      }
      return;
    }

    const normalizedInput = normalizeInput(input);
    if (normalizedInput.length === 0) {
      return;
    }

    updateValue(
      value.slice(0, cursorOffset) + normalizedInput + value.slice(cursorOffset),
      cursorOffset + normalizedInput.length,
    );
  });

  const rows = wrapInput(value, contentWidth);
  const cursorRowIndex = findCursorRowIndex(rows, cursorOffset);
  const visibleRows = selectVisibleRows(rows, cursorRowIndex, contentHeight);

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} height={height} width={width}>
      <Box flexDirection="column" height={contentHeight}>
        {visibleRows.map((row, index) => (
          <Box key={`${row.start}-${row.end}-${index}`} height={1}>
            <Text color="green" bold>
              {index === 0 ? "> " : "  "}
            </Text>
            {renderInputRow({
              row,
              cursorOffset,
              showCursor: !isLoading,
              value,
              placeholder: "Type a message or use @path for files/folders",
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function normalizeInput(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

function wrapInput(value: string, width: number): WrappedRow[] {
  const rows: WrappedRow[] = [];
  let text = "";
  let start = 0;
  let index = 0;

  while (index < value.length) {
    const char = value[index] ?? "";

    if (char === "\n") {
      rows.push({ text, start, end: index });
      index++;
      start = index;
      text = "";
      continue;
    }

    if (text.length >= width) {
      rows.push({ text, start, end: index });
      start = index;
      text = "";
    }

    text += char;
    index++;
  }

  rows.push({ text, start, end: value.length });
  return rows;
}

function findCursorRowIndex(rows: WrappedRow[], cursorOffset: number): number {
  const index = rows.findIndex((row) => cursorOffset >= row.start && cursorOffset <= row.end);
  return index >= 0 ? index : rows.length - 1;
}

function selectVisibleRows(
  rows: WrappedRow[],
  cursorRowIndex: number,
  height: number,
): WrappedRow[] {
  const start = clamp(cursorRowIndex - height + 1, 0, Math.max(0, rows.length - height));
  const selected = rows.slice(start, start + height);

  while (selected.length < height) {
    const lastEnd = selected[selected.length - 1]?.end ?? 0;
    selected.push({ text: "", start: lastEnd, end: lastEnd });
  }

  return selected;
}

function renderInputRow({
  row,
  cursorOffset,
  showCursor,
  value,
  placeholder,
}: {
  readonly row: WrappedRow;
  readonly cursorOffset: number;
  readonly showCursor: boolean;
  readonly value: string;
  readonly placeholder: string;
}): React.JSX.Element {
  if (value.length === 0 && row.start === 0) {
    return (
      <>
        {showCursor ? <Text inverse> </Text> : null}
        <Text dimColor>{placeholder}</Text>
      </>
    );
  }

  const cursorInside = showCursor && cursorOffset >= row.start && cursorOffset <= row.end;
  if (!cursorInside) {
    return <Text>{row.text}</Text>;
  }

  const cursorIndex = cursorOffset - row.start;
  const before = row.text.slice(0, cursorIndex);
  const cursorChar = cursorIndex < row.text.length ? row.text[cursorIndex] : " ";
  const after = cursorIndex < row.text.length ? row.text.slice(cursorIndex + 1) : "";

  return (
    <>
      <Text>{before}</Text>
      <Text inverse>{cursorChar}</Text>
      <Text>{after}</Text>
    </>
  );
}

function findPreviousWordStart(value: string, cursorOffset: number): number {
  let index = cursorOffset;

  while (index > 0 && /\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  while (index > 0 && !/\s/.test(value[index - 1] ?? "")) {
    index--;
  }

  return index;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
