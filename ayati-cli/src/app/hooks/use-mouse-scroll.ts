import { useEffect } from "react";
import { useStdin, useStdout } from "ink";
import {
  MOUSE_SCROLL_EVENT,
  type MouseScrollEvent,
  type MouseTrackingStdin,
} from "../input/terminal-mouse.js";

type Options = {
  readonly enabled?: boolean;
  readonly onScroll: (event: MouseScrollEvent) => void;
};

const ENABLE_MOUSE_SCROLL = "\u001B[?1000h\u001B[?1006h";
const DISABLE_MOUSE_SCROLL = "\u001B[?1000l\u001B[?1006l";

export function useMouseScroll({
  enabled = true,
  onScroll,
}: Options): void {
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  useEffect(() => {
    if (!enabled || !isRawModeSupported || !stdout.isTTY) {
      return;
    }

    stdout.write(ENABLE_MOUSE_SCROLL);

    return () => {
      stdout.write(DISABLE_MOUSE_SCROLL);
    };
  }, [enabled, isRawModeSupported, stdout]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const mouseAwareStdin = stdin as unknown as MouseTrackingStdin;
    if (typeof mouseAwareStdin.on !== "function") {
      return;
    }

    mouseAwareStdin.on(MOUSE_SCROLL_EVENT, onScroll);

    return () => {
      mouseAwareStdin.off(MOUSE_SCROLL_EVENT, onScroll);
    };
  }, [enabled, onScroll, stdin]);
}
