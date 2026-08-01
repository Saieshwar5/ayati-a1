import { describe, expect, it } from "vitest";
import {
  formatUnixFileMode,
  parseUnixFileMode,
} from "../../src/shared/unix-file-mode.js";

describe("Unix file mode metadata", () => {
  it.each([
    [0o644, "0644", "rw-r--r--"],
    [0o755, "0755", "rwxr-xr-x"],
    [0o4755, "4755", "rwsr-xr-x"],
    [0o2640, "2640", "rw-r-S---"],
    [0o1600, "1600", "rw------T"],
  ])("formats %s as octal and symbolic permissions", (mode, modeOctal, modeSymbolic) => {
    expect(formatUnixFileMode(mode)).toEqual({ modeOctal, modeSymbolic });
  });

  it("accepts only internally consistent normalized metadata", () => {
    expect(parseUnixFileMode("0640", "rw-r-----")).toEqual({
      modeOctal: "0640",
      modeSymbolic: "rw-r-----",
    });
    expect(parseUnixFileMode("640", "rw-r-----")).toBeUndefined();
    expect(parseUnixFileMode("0640", "rwxrwxrwx")).toBeUndefined();
  });
});
