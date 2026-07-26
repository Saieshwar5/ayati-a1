import { describe, expect, it } from "vitest";
import { validateTaskValidationRequest } from "../../src/ivec/agent-runner/task-validation-request.js";

describe("task validation request policy", () => {
  it("accepts exact registered semantic and filesystem outcomes", () => {
    expect(validateTaskValidationRequest([
      {
        kind: "process.exit_success",
        subject: "pnpm --filter ayati-main test",
      },
      {
        kind: "file.written",
        subject: "/tmp/site/index.html",
        expectedKind: "file",
      },
    ])).toBeUndefined();
  });

  it("accepts exact slice, search, and profile read scopes", () => {
    expect(validateTaskValidationRequest([
      {
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        expectedKind: "file",
        readScope: {
          mode: "slice",
          startLine: 40,
          endLine: 65,
        },
      },
      {
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        readScope: {
          mode: "search",
          query: "createParser",
        },
      },
      {
        kind: "file.read_scope_satisfied",
        subject: "/tmp/source.ts",
        readScope: { mode: "profile" },
      },
    ])).toBeUndefined();
  });

  it("accepts a no-match search only with an exact absolute search scope", () => {
    expect(validateTaskValidationRequest([{
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["/workspace"],
        maxDepth: 10,
        includeHidden: false,
      },
    }])).toBeUndefined();

    expect(validateTaskValidationRequest([{
      kind: "file.search_no_match",
      subject: "missing-report.txt",
    }])).toMatchObject({
      message: expect.stringContaining("requires one exact searchScope"),
    });

    expect(validateTaskValidationRequest([{
      kind: "file.search_no_match",
      subject: "missing-report.txt",
      searchScope: {
        roots: ["workspace"],
        maxDepth: 10,
        includeHidden: false,
      },
    }])).toMatchObject({
      message: expect.stringContaining("canonical absolute paths"),
    });
  });

  it("requires at least one important responsibility outcome", () => {
    expect(validateTaskValidationRequest([])).toMatchObject({
      message: expect.stringContaining("at least one exact important responsibility outcome"),
      subjects: [],
    });
    expect(validateTaskValidationRequest(undefined)).toMatchObject({
      message: expect.stringContaining("at least one exact important responsibility outcome"),
    });
  });

  it("rejects relative filesystem subjects", () => {
    expect(validateTaskValidationRequest([{
      kind: "file.read_complete",
      subject: "notes/report.txt",
      expectedKind: "file",
    }])).toMatchObject({
      message: expect.stringContaining("canonical absolute path"),
      subjects: ["notes/report.txt"],
    });
  });

  it("rejects filesystem-only expected kinds on semantic outcomes", () => {
    expect(validateTaskValidationRequest([{
      kind: "database.read_succeeded",
      subject: "customers",
      expectedKind: "file",
    }])).toMatchObject({
      message: expect.stringContaining("expectedKind is valid only for filesystem"),
      subjects: ["customers"],
    });
  });

  it("rejects empty semantic subjects", () => {
    expect(validateTaskValidationRequest([{
      kind: "calculation.evaluated",
      subject: "   ",
    }])).toMatchObject({
      message: expect.stringContaining("exact non-empty subject"),
      subjects: [],
    });
  });

  it("requires a valid read scope only for scoped-read outcomes", () => {
    expect(validateTaskValidationRequest([{
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
    }])).toMatchObject({
      message: expect.stringContaining("requires one exact readScope"),
    });
    expect(validateTaskValidationRequest([{
      kind: "file.read_scope_satisfied",
      subject: "/tmp/source.ts",
      readScope: {
        mode: "slice",
        startLine: 20,
        endLine: 10,
      },
    }])).toMatchObject({
      message: expect.stringContaining("positive integer startLine/endLine"),
    });
    expect(validateTaskValidationRequest([{
      kind: "file.read_complete",
      subject: "/tmp/source.ts",
      readScope: { mode: "profile" },
    }])).toMatchObject({
      message: expect.stringContaining("readScope is valid only"),
    });
  });
});
