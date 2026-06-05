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

  it("accepts agent CLI UI context for render placement", () => {
    const parsed = parseChatInboundMessage({
      type: "chat",
      content: "Open the lesson",
      uiContext: {
        source: "agent-cli",
        processPid: 222,
        terminalPid: 111,
        processTreePids: [222, 200, 111],
        windowAddress: "0xabc",
        windowClass: "Alacritty",
        windowTitle: "ayati-a1",
        workspaceId: 3,
        workspaceName: "3",
        monitor: "eDP-1",
        detectedAt: "2026-06-04T10:00:00.000Z",
      },
    });

    expect(parsed).toEqual({
      type: "chat",
      content: "Open the lesson",
      uiContext: {
        source: "agent-cli",
        processPid: 222,
        terminalPid: 111,
        processTreePids: [222, 200, 111],
        windowAddress: "0xabc",
        windowClass: "Alacritty",
        windowTitle: "ayati-a1",
        workspaceId: 3,
        workspaceName: "3",
        monitor: "eDP-1",
        detectedAt: "2026-06-04T10:00:00.000Z",
      },
    });
  });
});
