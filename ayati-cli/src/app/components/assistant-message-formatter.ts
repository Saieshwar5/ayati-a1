export type DisplaySegment = {
  readonly text: string;
  readonly color?: "green" | "cyan" | "yellow" | "magenta" | "red" | "gray";
  readonly backgroundColor?: "green" | "cyan" | "yellow" | "magenta" | "red" | "gray";
  readonly dimColor?: boolean;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly inverse?: boolean;
  readonly strikethrough?: boolean;
};

export type DisplayLine = {
  readonly segments: DisplaySegment[];
};

type SegmentStyle = Omit<DisplaySegment, "text">;

type AssistantBlock =
  | { readonly kind: "spacer" }
  | {
    readonly kind: "paragraph" | "bullet" | "label";
    readonly segments: DisplaySegment[];
  };

const BODY_PREFIX = "  ";
const BULLET_PREFIX = "  - ";
const BULLET_CONTINUATION_PREFIX = "    ";
const CODE_STYLE: SegmentStyle = {
  color: "yellow",
  inverse: true,
};

function hasSameStyle(left: SegmentStyle, right: SegmentStyle): boolean {
  return left.color === right.color
    && left.backgroundColor === right.backgroundColor
    && left.dimColor === right.dimColor
    && left.bold === right.bold
    && left.italic === right.italic
    && left.underline === right.underline
    && left.inverse === right.inverse
    && left.strikethrough === right.strikethrough;
}

function pushSegment(target: DisplaySegment[], next: DisplaySegment): void {
  if (next.text.length === 0) {
    return;
  }

  const previous = target[target.length - 1];
  if (!previous || !hasSameStyle(previous, next)) {
    target.push(next);
    return;
  }

  target[target.length - 1] = {
    ...previous,
    text: `${previous.text}${next.text}`,
  };
}

function mergeSegments(segments: DisplaySegment[]): DisplaySegment[] {
  const merged: DisplaySegment[] = [];

  for (const segment of segments) {
    pushSegment(merged, segment);
  }

  return merged;
}

function parseInlineSegments(text: string, baseStyle: SegmentStyle = {}): DisplaySegment[] {
  const segments: DisplaySegment[] = [];
  let index = 0;

  const pushPlain = (value: string): void => {
    if (value.length === 0) {
      return;
    }

    pushSegment(segments, {
      text: value,
      ...baseStyle,
    });
  };

  while (index < text.length) {
    const boldIndex = text.indexOf("**", index);
    const codeIndex = text.indexOf("`", index);
    const nextTokenIndex = [boldIndex, codeIndex]
      .filter((value) => value >= 0)
      .sort((left, right) => left - right)[0];

    if (nextTokenIndex === undefined) {
      pushPlain(text.slice(index));
      break;
    }

    if (nextTokenIndex > index) {
      pushPlain(text.slice(index, nextTokenIndex));
    }

    if (nextTokenIndex === codeIndex) {
      const closingIndex = text.indexOf("`", codeIndex + 1);
      if (closingIndex === -1 || closingIndex === codeIndex + 1) {
        pushPlain(text.slice(codeIndex));
        break;
      }

      pushSegment(segments, {
        text: text.slice(codeIndex + 1, closingIndex),
        ...CODE_STYLE,
      });
      index = closingIndex + 1;
      continue;
    }

    const closingIndex = text.indexOf("**", boldIndex + 2);
    if (closingIndex === -1 || closingIndex === boldIndex + 2) {
      pushPlain(text.slice(boldIndex));
      break;
    }

    pushSegment(segments, {
      text: text.slice(boldIndex + 2, closingIndex),
      ...baseStyle,
      bold: true,
    });
    index = closingIndex + 2;
  }

  return mergeSegments(segments);
}

function parseAssistantBlocks(
  content: string,
  assistantColor: NonNullable<DisplaySegment["color"]>,
): AssistantBlock[] {
  const lines = content.split(/\r?\n/);

  return lines.map((rawLine) => {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      return { kind: "spacer" } as const;
    }

    const labelMatch = /^\*\*(.+?)\*\*$/.exec(trimmed);
    if (labelMatch && labelMatch[1]) {
      return {
        kind: "label" as const,
        segments: parseInlineSegments(labelMatch[1], {
          color: assistantColor,
          bold: true,
        }),
      };
    }

    if (trimmed.startsWith("- ")) {
      return {
        kind: "bullet" as const,
        segments: parseInlineSegments(trimmed.slice(2)),
      };
    }

    return {
      kind: "paragraph" as const,
      segments: parseInlineSegments(trimmed),
    };
  });
}

function toWordSegments(segments: DisplaySegment[]): DisplaySegment[] {
  const words: DisplaySegment[] = [];

  for (const segment of segments) {
    const pieces = segment.text.split(/\s+/).filter((piece) => piece.length > 0);
    for (const piece of pieces) {
      words.push({
        ...segment,
        text: piece,
      });
    }
  }

  return words;
}

function createLine(prefix: string): {
  segments: DisplaySegment[];
  length: number;
  hasContent: boolean;
} {
  return {
    segments: prefix.length > 0 ? [{ text: prefix }] : [],
    length: prefix.length,
    hasContent: false,
  };
}

function wrapFormattedSegments(params: {
  segments: DisplaySegment[];
  width: number;
  prefix: string;
  continuationPrefix?: string;
}): DisplayLine[] {
  const {
    segments,
    width,
    prefix,
    continuationPrefix = prefix,
  } = params;
  const words = toWordSegments(segments);
  if (words.length === 0) {
    return [{ segments: [] }];
  }

  const effectiveWidth = Math.max(
    width,
    prefix.length + 1,
    continuationPrefix.length + 1,
  );
  const lines: DisplayLine[] = [];
  let line = createLine(prefix);

  const pushLine = (): void => {
    lines.push({ segments: mergeSegments(line.segments) });
    line = createLine(continuationPrefix);
  };

  for (const word of words) {
    let remaining = word.text;

    while (remaining.length > 0) {
      if (line.hasContent) {
        const neededLength = 1 + remaining.length;
        if (line.length + neededLength <= effectiveWidth) {
          pushSegment(line.segments, { text: " " });
          pushSegment(line.segments, {
            ...word,
            text: remaining,
          });
          line.length += neededLength;
          remaining = "";
          continue;
        }

        if (remaining.length <= effectiveWidth - continuationPrefix.length) {
          pushLine();
          continue;
        }

        pushLine();
        continue;
      }

      const availableWidth = Math.max(1, effectiveWidth - line.length);
      if (remaining.length <= availableWidth) {
        pushSegment(line.segments, {
          ...word,
          text: remaining,
        });
        line.length += remaining.length;
        line.hasContent = true;
        remaining = "";
        continue;
      }

      pushSegment(line.segments, {
        ...word,
        text: remaining.slice(0, availableWidth),
      });
      line.length += availableWidth;
      line.hasContent = true;
      remaining = remaining.slice(availableWidth);
      pushLine();
    }
  }

  lines.push({ segments: mergeSegments(line.segments) });
  return lines;
}

export function formatAssistantMessage(params: {
  content: string;
  width: number;
  assistantColor: NonNullable<DisplaySegment["color"]>;
}): DisplayLine[] {
  const { content, width, assistantColor } = params;
  const blocks = parseAssistantBlocks(content, assistantColor);
  const lines: DisplayLine[] = [];

  for (const block of blocks) {
    if (block.kind === "spacer") {
      lines.push({ segments: [] });
      continue;
    }

    if (block.kind === "bullet") {
      lines.push(...wrapFormattedSegments({
        segments: block.segments,
        width,
        prefix: BULLET_PREFIX,
        continuationPrefix: BULLET_CONTINUATION_PREFIX,
      }));
      continue;
    }

    lines.push(...wrapFormattedSegments({
      segments: block.segments,
      width,
      prefix: BODY_PREFIX,
    }));
  }

  return lines;
}
