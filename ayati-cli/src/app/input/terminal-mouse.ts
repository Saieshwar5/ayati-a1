import { PassThrough } from "node:stream";

export const MOUSE_SCROLL_EVENT = "mouse-scroll";

export type MouseScrollEvent = {
  readonly direction: "up" | "down";
  readonly amount: number;
};

type ParseMouseScrollEventsResult = {
  readonly cleanedInput: string;
  readonly events: MouseScrollEvent[];
  readonly remainder: string;
};

const MOUSE_SEQUENCE_PREFIX = "\u001B[<";
const COMPLETE_MOUSE_SEQUENCE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;
const INCOMPLETE_MOUSE_SEQUENCE = /^\u001B\[<[0-9;]*$/;

function toScrollEvent(
  buttonCode: number,
  terminator: string,
): MouseScrollEvent | null {
  if (terminator !== "M") {
    return null;
  }

  const isWheelEvent = (buttonCode & 64) === 64;
  if (!isWheelEvent) {
    return null;
  }

  const wheelButton = buttonCode & 0b11;
  if (wheelButton === 0) {
    return { direction: "up", amount: 1 };
  }

  if (wheelButton === 1) {
    return { direction: "down", amount: 1 };
  }

  return null;
}

function splitCompleteInput(input: string): {
  readonly completeInput: string;
  readonly remainder: string;
} {
  const lastPrefixIndex = input.lastIndexOf(MOUSE_SEQUENCE_PREFIX);
  if (lastPrefixIndex === -1) {
    return {
      completeInput: input,
      remainder: "",
    };
  }

  const trailingSegment = input.slice(lastPrefixIndex);
  if (!INCOMPLETE_MOUSE_SEQUENCE.test(trailingSegment)) {
    return {
      completeInput: input,
      remainder: "",
    };
  }

  return {
    completeInput: input.slice(0, lastPrefixIndex),
    remainder: trailingSegment,
  };
}

export function extractMouseScrollEvents(
  chunk: string,
  previousRemainder = "",
): ParseMouseScrollEventsResult {
  const combined = `${previousRemainder}${chunk}`;
  const { completeInput, remainder } = splitCompleteInput(combined);
  const events: MouseScrollEvent[] = [];

  const cleanedInput = completeInput.replace(
    COMPLETE_MOUSE_SEQUENCE,
    (_sequence, rawButtonCode: string, _x: string, _y: string, terminator: string) => {
      const event = toScrollEvent(Number(rawButtonCode), terminator);
      if (event) {
        events.push(event);
      }

      return "";
    },
  );

  return {
    cleanedInput,
    events,
    remainder,
  };
}

export type MouseTrackingStdin = PassThrough & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
  ref?: () => MouseTrackingStdin;
  unref?: () => MouseTrackingStdin;
  on(event: typeof MOUSE_SCROLL_EVENT, listener: (event: MouseScrollEvent) => void): MouseTrackingStdin;
  off(event: typeof MOUSE_SCROLL_EVENT, listener: (event: MouseScrollEvent) => void): MouseTrackingStdin;
};

export function createMouseTrackingStdin(source: NodeJS.ReadStream): MouseTrackingStdin {
  const stdin = new PassThrough() as MouseTrackingStdin;
  let remainder = "";

  const handleSourceData = (chunk: string | Buffer): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const result = extractMouseScrollEvents(text, remainder);
    remainder = result.remainder;

    for (const event of result.events) {
      stdin.emit(MOUSE_SCROLL_EVENT, event);
    }

    if (result.cleanedInput.length > 0) {
      stdin.write(result.cleanedInput);
    }
  };

  const handleSourceEnd = (): void => {
    if (remainder.length > 0) {
      stdin.write(remainder);
      remainder = "";
    }

    stdin.end();
  };

  const handleSourceError = (error: Error): void => {
    stdin.destroy(error);
  };

  source.on("data", handleSourceData);
  source.on("end", handleSourceEnd);
  source.on("error", handleSourceError);

  stdin.isTTY = source.isTTY;
  stdin.setRawMode = source.setRawMode?.bind(source);
  stdin.ref = () => {
    source.ref?.();
    return stdin;
  };
  stdin.unref = () => {
    source.unref?.();
    return stdin;
  };

  const destroy = stdin.destroy.bind(stdin);
  stdin.destroy = ((error?: Error) => {
    source.off("data", handleSourceData);
    source.off("end", handleSourceEnd);
    source.off("error", handleSourceError);
    return destroy(error);
  }) as typeof stdin.destroy;

  return stdin;
}
