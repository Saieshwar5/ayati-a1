import { describe, expect, it } from "vitest";
import { parseChatInboundMessage } from "../../src/ivec/index.js";

describe("parseChatInboundMessage", () => {
  it("keeps CLI attachments backward compatible when source is omitted", () => {
    const parsed = parseChatInboundMessage({
      type: "chat",
      content: "Read this file",
      attachments: [{ path: "/tmp/policy.txt", name: "policy.txt" }],
    });

    expect(parsed).toEqual({
      type: "chat",
      content: "Read this file",
      attachments: [{ source: "cli", path: "/tmp/policy.txt", name: "policy.txt" }],
    });
  });

  it("accepts uploaded attachment metadata", () => {
    const parsed = parseChatInboundMessage({
      type: "chat",
      content: "Summarize the upload",
      attachments: [
        {
          source: "upload",
          uploadedPath: "/tmp/uploads/abc/policy.txt",
          originalName: "policy.txt",
          mimeType: "text/plain",
          sizeBytes: 128,
        },
      ],
    });

    expect(parsed).toEqual({
      type: "chat",
      content: "Summarize the upload",
      attachments: [
        {
          source: "upload",
          uploadedPath: "/tmp/uploads/abc/policy.txt",
          originalName: "policy.txt",
          mimeType: "text/plain",
          sizeBytes: 128,
        },
      ],
    });
  });

  it("accepts explicit file attachments", () => {
    const parsed = parseChatInboundMessage({
      type: "chat",
      content: "Read this file",
      attachments: [{ type: "file", path: "/tmp/policy.txt", name: "policy.txt" }],
    });

    expect(parsed).toEqual({
      type: "chat",
      content: "Read this file",
      attachments: [{ type: "file", source: "cli", path: "/tmp/policy.txt", name: "policy.txt" }],
    });
  });

  it("accepts explicit directory attachments", () => {
    const parsed = parseChatInboundMessage({
      type: "chat",
      content: "Inspect this project",
      attachments: [
        {
          type: "directory",
          path: "/tmp/project",
          name: "project",
          include: ["**/*.ts"],
          exclude: ["node_modules"],
          maxDepth: 4,
          maxFiles: 50,
        },
      ],
    });

    expect(parsed).toEqual({
      type: "chat",
      content: "Inspect this project",
      attachments: [
        {
          type: "directory",
          source: "cli",
          path: "/tmp/project",
          name: "project",
          include: ["**/*.ts"],
          exclude: ["node_modules"],
          maxDepth: 4,
          maxFiles: 50,
        },
      ],
    });
  });

  it("ignores malformed web attachment rows", () => {
    const parsed = parseChatInboundMessage({
      type: "chat",
      content: "Hello",
      attachments: [
        { source: "upload", uploadedPath: "/tmp/uploads/abc/policy.txt" },
        { source: "upload", originalName: "policy.txt" },
      ],
    });

    expect(parsed).toEqual({
      type: "chat",
      content: "Hello",
    });
  });
});
