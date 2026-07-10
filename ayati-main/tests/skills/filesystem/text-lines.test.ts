import { describe, expect, it } from "vitest";
import {
  countFileLines,
  lineNumberAtOffset,
  splitFileLineSpans,
  splitFileLines,
} from "../../../src/skills/builtins/filesystem/text-lines.js";

describe("filesystem text line helpers", () => {
  it("uses one file line-count contract for common newline shapes", () => {
    expect(countFileLines("")).toBe(0);
    expect(countFileLines("alpha")).toBe(1);
    expect(countFileLines("alpha\n")).toBe(1);
    expect(countFileLines("alpha\nbeta")).toBe(2);
    expect(countFileLines("alpha\nbeta\n")).toBe(2);
    expect(countFileLines("alpha\n\n")).toBe(2);
    expect(countFileLines("\n")).toBe(1);
    expect(countFileLines("alpha\r\nbeta\r\n")).toBe(2);
  });

  it("splits content lines without adding a synthetic final empty line", () => {
    expect(splitFileLines("alpha\nbeta\n")).toEqual(["alpha", "beta"]);
    expect(splitFileLines("alpha\n\n")).toEqual(["alpha", ""]);
    expect(splitFileLines("")).toEqual([]);
  });

  it("keeps source spans aligned with file line numbers", () => {
    expect(splitFileLineSpans("a\r\nb\n")).toEqual([
      { text: "a", start: 0, end: 1 },
      { text: "b", start: 3, end: 4 },
    ]);
    expect(lineNumberAtOffset("a\r\nb\nc", 3)).toBe(2);
    expect(lineNumberAtOffset("a\r\nb\nc", 5)).toBe(3);
  });
});
