import { describe, expect, it } from "vitest";
import { formatAssistantMessage } from "./assistant-message-formatter.js";

function lineText(index: number, lines: ReturnType<typeof formatAssistantMessage>): string {
  return lines[index]?.segments.map((segment) => segment.text).join("") ?? "";
}

describe("assistant-message-formatter", () => {
  it("renders short all-bold lines as assistant section labels", () => {
    const lines = formatAssistantMessage({
      content: "**what's running:**",
      width: 40,
      assistantColor: "cyan",
    });

    expect(lineText(0, lines)).toBe("  what's running:");
    expect(lines[0]?.segments.some((segment) => (
      segment.text === "what's" && segment.color === "cyan" && segment.bold
    ))).toBe(true);
    expect(lines[0]?.segments.some((segment) => (
      segment.text === "running:" && segment.color === "cyan" && segment.bold
    ))).toBe(true);
  });

  it("renders inline bold and code spans without raw markdown markers", () => {
    const lines = formatAssistantMessage({
      content: "- **command:** `free -h`",
      width: 40,
      assistantColor: "cyan",
    });

    expect(lineText(0, lines)).toBe("  - command: free -h");
    expect(lines[0]?.segments.some((segment) => segment.text.includes("**"))).toBe(false);
    expect(lines[0]?.segments.some((segment) => segment.text.includes("`"))).toBe(false);
    expect(lines[0]?.segments.some((segment) => segment.text === "command:" && segment.bold)).toBe(true);
    expect(lines[0]?.segments.some((segment) => segment.text === "free" && segment.inverse)).toBe(true);
  });

  it("preserves blank lines between assistant sections", () => {
    const lines = formatAssistantMessage({
      content: "**first:**\n\n- item",
      width: 40,
      assistantColor: "cyan",
    });

    expect(lineText(0, lines)).toBe("  first:");
    expect(lines[1]?.segments).toEqual([]);
    expect(lineText(2, lines)).toBe("  - item");
  });

  it("wraps bullet items with continuation indentation", () => {
    const lines = formatAssistantMessage({
      content: "- this is a very long bullet item",
      width: 14,
      assistantColor: "cyan",
    });

    expect(lineText(0, lines)).toBe("  - this is a");
    expect(lineText(1, lines)).toBe("    very long");
    expect(lineText(2, lines)).toBe("    bullet");
    expect(lineText(3, lines)).toBe("    item");
  });

  it("leaves unsupported markdown-like syntax as plain text", () => {
    const lines = formatAssistantMessage({
      content: "| task | active |",
      width: 40,
      assistantColor: "cyan",
    });

    expect(lineText(0, lines)).toBe("  | task | active |");
  });
});
