import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createMouseTrackingStdin,
  extractMouseScrollEvents,
  MOUSE_SCROLL_EVENT,
  type MouseScrollEvent,
} from "./terminal-mouse.js";

class MockReadStream extends PassThrough {
  readonly isTTY = true;

  setRawMode = vi.fn();

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }
}

describe("terminal-mouse", () => {
  it("extracts vertical wheel events and removes them from input", () => {
    const result = extractMouseScrollEvents("hello\u001B[<64;12;8Mworld");

    expect(result.cleanedInput).toBe("helloworld");
    expect(result.events).toEqual([
      { direction: "up", amount: 1 },
    ]);
    expect(result.remainder).toBe("");
  });

  it("buffers incomplete mouse sequences until the next chunk arrives", () => {
    const first = extractMouseScrollEvents("\u001B[<65;4", "");
    expect(first.cleanedInput).toBe("");
    expect(first.events).toEqual([]);
    expect(first.remainder).toBe("\u001B[<65;4");

    const second = extractMouseScrollEvents(";9Mok", first.remainder);
    expect(second.cleanedInput).toBe("ok");
    expect(second.events).toEqual([
      { direction: "down", amount: 1 },
    ]);
    expect(second.remainder).toBe("");
  });

  it("drops non-scroll mouse sequences instead of forwarding them to text input", () => {
    const result = extractMouseScrollEvents("x\u001B[<0;10;5My");

    expect(result.cleanedInput).toBe("xy");
    expect(result.events).toEqual([]);
    expect(result.remainder).toBe("");
  });

  it("emits scroll events while forwarding non-mouse input", async () => {
    const source = new MockReadStream();
    const stdin = createMouseTrackingStdin(source as unknown as NodeJS.ReadStream);
    const events: MouseScrollEvent[] = [];
    const chunks: string[] = [];

    stdin.on(MOUSE_SCROLL_EVENT, (event) => {
      events.push(event);
    });
    stdin.on("data", (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    });

    source.write("a");
    source.write("\u001B[<64;10;5M");
    source.write("b");
    source.end();

    await new Promise((resolve) => stdin.on("end", resolve));

    expect(chunks.join("")).toBe("ab");
    expect(events).toEqual([
      { direction: "up", amount: 1 },
    ]);
  });
});
