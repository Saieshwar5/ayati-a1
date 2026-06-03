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
