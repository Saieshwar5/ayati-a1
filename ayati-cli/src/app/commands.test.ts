import { describe, expect, it } from "vitest";
import { parseCliCommand } from "./commands.js";

describe("parseCliCommand", () => {
  it("keeps /clear as the only document-related command", () => {
    expect(parseCliCommand("/clear")).toEqual({ type: "clearDocs" });
  });
});
