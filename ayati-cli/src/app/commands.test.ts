import { describe, expect, it } from "vitest";
import { ATTACH_USAGE, parseCliCommand } from "./commands.js";

describe("parseCliCommand", () => {
  it("parses /files", () => {
    expect(parseCliCommand("/files")).toEqual({ type: "files" });
  });

  it("parses /clearfiles", () => {
    expect(parseCliCommand("/clearfiles")).toEqual({ type: "clearfiles" });
  });

  it("parses queued /attach paths", () => {
    expect(parseCliCommand("/attach /tmp/policy.txt")).toEqual({
      type: "attach",
      rawPath: "/tmp/policy.txt",
    });
  });

  it("parses quoted /attach paths", () => {
    expect(parseCliCommand("/attach \"/tmp/Anoosh Resume.pdf\"")).toEqual({
      type: "attach",
      rawPath: "/tmp/Anoosh Resume.pdf",
    });
  });

  it("parses /attach with an inline message", () => {
    expect(parseCliCommand("/attach /tmp/policy.txt -- summarize this")).toEqual({
      type: "attach",
      rawPath: "/tmp/policy.txt",
      content: "summarize this",
    });
  });

  it("supports spaces in unquoted paths when using the message separator", () => {
    expect(parseCliCommand("/attach /tmp/Anoosh's Resume (4).pdf -- give me the education details")).toEqual({
      type: "attach",
      rawPath: "/tmp/Anoosh's Resume (4).pdf",
      content: "give me the education details",
    });
  });

  it("rejects /attach with no path", () => {
    expect(parseCliCommand("/attach")).toEqual({
      type: "invalid",
      message: ATTACH_USAGE,
    });
  });

  it("rejects /attach separators without a message", () => {
    expect(parseCliCommand("/attach /tmp/policy.txt -- ")).toEqual({
      type: "invalid",
      message: ATTACH_USAGE,
    });
  });
});
