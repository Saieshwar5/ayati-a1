import {
  describe,
  expect,
  it,
} from "vitest";
import {
  clamp,
  resolveScrollTopAfterContentChange,
  scrollByLines,
  scrollByPages,
} from "./message-list-scroll.js";

describe("message-list-scroll", () => {
  it("clamps scroll positions inside the valid range", () => {
    expect(clamp(-2, 0, 5)).toBe(0);
    expect(clamp(3, 0, 5)).toBe(3);
    expect(clamp(7, 0, 5)).toBe(5);
  });

  it("scrolls by line and page increments", () => {
    expect(scrollByLines(4, -2, 10)).toBe(2);
    expect(scrollByLines(9, 4, 10)).toBe(10);
    expect(scrollByPages(6, -1, 4, 12)).toBe(2);
    expect(scrollByPages(6, 2, 4, 12)).toBe(12);
  });

  it("stays pinned to the bottom only when already at the bottom", () => {
    expect(resolveScrollTopAfterContentChange({
      scrollTop: 7,
      previousMaxScrollTop: 7,
      nextMaxScrollTop: 11,
    })).toBe(11);

    expect(resolveScrollTopAfterContentChange({
      scrollTop: 3,
      previousMaxScrollTop: 7,
      nextMaxScrollTop: 11,
    })).toBe(3);
  });
});
