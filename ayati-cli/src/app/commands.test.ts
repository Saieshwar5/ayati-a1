import { describe, expect, it } from "vitest";
import { parseCliCommand } from "./commands.js";

describe("parseCliCommand", () => {
  it("keeps /clear as the only document-related command", () => {
    expect(parseCliCommand("/clear")).toEqual({ type: "clearDocs" });
  });

  it("does not expose numbered attachment management commands", () => {
    const docsCommand = `/${"docs"}`;
    const removeCommand = `/${"remove"} 1`;
    expect(parseCliCommand(docsCommand)).toEqual({ type: "unknown" });
    expect(parseCliCommand(removeCommand)).toEqual({ type: "unknown" });
  });

  it("does not recognize removed legacy document commands", () => {
    const legacyCommand = `/${"attach"} /tmp/policy.txt`;
    expect(parseCliCommand(legacyCommand)).toEqual({ type: "unknown" });
  });
});
