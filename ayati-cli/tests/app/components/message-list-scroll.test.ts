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
} from "../../../src/app/components/message-list-scroll.js";

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

  it("follows output independently of a stale scroll position", () => {
    expect(resolveScrollTopAfterContentChange({
      scrollTop: 3,
      nextMaxScrollTop: 11,
      followOutput: true,
    })).toBe(11);

    expect(resolveScrollTopAfterContentChange({
      scrollTop: 3,
      nextMaxScrollTop: 11,
      followOutput: false,
    })).toBe(3);
  });

  it("clamps a manually anchored viewport when content shrinks", () => {
    expect(resolveScrollTopAfterContentChange({
      scrollTop: 9,
      nextMaxScrollTop: 4,
      followOutput: false,
    })).toBe(4);
  });
});
