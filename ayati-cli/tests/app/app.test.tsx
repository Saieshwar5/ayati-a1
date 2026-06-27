import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React, { act } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "../../src/app/types.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const websocketState = vi.hoisted(() => ({
  onMessage: null as null | ((data: ServerMessage | Record<string, unknown>) => void),
  send: vi.fn(),
}));

vi.mock("../../src/app/hooks/use-websocket.js", () => ({
  useWebSocket: ({
    onMessage,
  }: {
    onMessage: (data: ServerMessage | Record<string, unknown>) => void;
  }) => {
    websocketState.onMessage = onMessage;
    return {
      send: websocketState.send,
      connected: true,
    };
  },
}));

vi.mock("../../src/app/ui-context.js", () => ({
  detectAgentCliUiContext: vi.fn().mockResolvedValue(null),
}));

import { App } from "../../src/app/app.js";

type RenderedApp = ReturnType<typeof render>;
let tempDir: string | null = null;

function deliver(message: ServerMessage): void {
  if (!websocketState.onMessage) {
    throw new Error("websocket mock not initialized");
  }

  websocketState.onMessage(message);
}

async function renderApp(): Promise<RenderedApp> {
  let app: RenderedApp | null = null;

  await act(async () => {
    app = render(<App />);
  });

  if (!app) {
    throw new Error("app render failed");
  }

  return app as RenderedApp;
}

function createTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "ayati-cli-app-"));
  return tempDir;
}

async function writeInput(app: RenderedApp, value: string): Promise<void> {
  await act(async () => {
    app.stdin.write(value);
  });
  await pressEnter(app);
}

async function pressEnter(app: RenderedApp): Promise<void> {
  await act(async () => {
    app.stdin.write("\r");
  });
}

function sentMessages(): unknown[] {
  return websocketState.send.mock.calls.map((call) => call[0]);
}

function sentChatMessages(): unknown[] {
  return sentMessages().filter((message) => (
    typeof message === "object"
    && message !== null
    && (message as { type?: unknown }).type === "chat"
  ));
}

function workspaceEvent(event: string): unknown {
  return expect.objectContaining({
    type: "workspace_event",
    event,
    workspaceSessionId: expect.any(String),
  });
}

describe("App", () => {
  afterEach(() => {
    websocketState.onMessage = null;
    websocketState.send.mockReset();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("renders notifications from the backend", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      deliver({
        type: "notification",
        content: "Memory check complete.",
      });
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ayati [notification]");
    expect(frame).toContain("Memory check complete.");

    await act(async () => {
      unmount();
    });
  });

  it("accepts new input after a final backend notification", async () => {
    const app = await renderApp();

    await writeInput(app, "first message");
    await vi.waitFor(() => {
      expect(sentChatMessages()).toHaveLength(1);
    });

    await act(async () => {
      deliver({
        type: "notification",
        content: "Background task complete.",
        final: true,
      });
    });

    await writeInput(app, "second message");

    await vi.waitFor(() => {
      expect(sentChatMessages()).toHaveLength(2);
      expect(sentChatMessages().at(-1)).toEqual({
        type: "chat",
        content: "second message",
      });
    });

    await act(async () => {
      app.unmount();
    });
  });

  it("sends workspace compose events around a submitted chat message", async () => {
    const app = await renderApp();

    await writeInput(app, "hello");

    await vi.waitFor(() => {
      const messages = sentMessages();
      expect(messages).toEqual(expect.arrayContaining([
        workspaceEvent("workspace_session_started"),
        workspaceEvent("cli_input_started"),
        workspaceEvent("cli_message_submitted"),
        { type: "chat", content: "hello" },
      ]));
      const submittedIndex = messages.findIndex((message) => (
        typeof message === "object"
        && message !== null
        && (message as { event?: unknown }).event === "cli_message_submitted"
      ));
      const chatIndex = messages.findIndex((message) => (
        typeof message === "object"
        && message !== null
        && (message as { type?: unknown }).type === "chat"
      ));
      expect(submittedIndex).toBeGreaterThanOrEqual(0);
      expect(chatIndex).toBeGreaterThan(submittedIndex);
    });

    await act(async () => {
      app.unmount();
    });
  });

  it("sends compose activity for later edits while draft text remains", async () => {
    const app = await renderApp();

    await vi.waitFor(() => {
      expect(sentMessages()).toContainEqual(workspaceEvent("workspace_session_started"));
    });
    websocketState.send.mockClear();

    await act(async () => {
      app.stdin.write("he");
    });

    await vi.waitFor(() => {
      expect(sentMessages()).toEqual([
        workspaceEvent("cli_input_started"),
      ]);
    });

    websocketState.send.mockClear();

    await act(async () => {
      app.stdin.write("llo");
    });

    await vi.waitFor(() => {
      expect(sentMessages()).toEqual([
        workspaceEvent("cli_input_started"),
      ]);
    });

    await act(async () => {
      app.unmount();
    });
  });

  it("renders feedback requests from the backend", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      deliver({
        type: "feedback",
        content: "Should I send this reply?",
      });
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ayati [feedback]");
    expect(frame).toContain("Should I send this reply?");

    await act(async () => {
      unmount();
    });
  });

  it("renders progress outside chat history and clears it after a reply", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      deliver({
        type: "progress",
        content: "Step 1: Inspect files -> succeeded",
        runId: "r1",
      });
    });

    let frame = lastFrame() ?? "";
    expect(frame).toContain("Ayati is working");
    expect(frame).toContain("Step 1: Inspect files -> succeeded");
    expect(frame).not.toContain("Ayati [progress]");

    await act(async () => {
      deliver({
        type: "reply",
        content: "Done.",
      });
    });

    frame = lastFrame() ?? "";
    expect(frame).toContain("Done.");
    expect(frame).not.toContain("Ayati is working");
    expect(frame).not.toContain("Step 1: Inspect files -> succeeded");

    await act(async () => {
      unmount();
    });
  });

  it("keeps only the latest progress lines", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      for (let index = 1; index <= 6; index++) {
        deliver({
          type: "progress",
          content: `Step ${index}: work item`,
          runId: "r1",
        });
      }
    });

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("Step 1: work item");
    expect(frame).toContain("Step 2: work item");
    expect(frame).toContain("Step 6: work item");

    await act(async () => {
      unmount();
    });
  });

  it("keeps reply messages labeled as normal assistant replies", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      deliver({
        type: "reply",
        content: "Here is the latest status.",
      });
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ayati");
    expect(frame).not.toContain("Ayati [notification]");
    expect(frame).not.toContain("Ayati [feedback]");
    expect(frame).toContain("Here is the latest status.");

    await act(async () => {
      unmount();
    });
  });

  it("renders backend errors with an explicit error label", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      deliver({
        type: "error",
        content: "Connection lost.",
      });
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("Ayati [error]");
    expect(frame).toContain("Connection lost.");

    await act(async () => {
      unmount();
    });
  });

  it("renders assistant markdown-like output without raw formatting markers", async () => {
    const { lastFrame, unmount } = await renderApp();

    await act(async () => {
      deliver({
        type: "notification",
        content: [
          "**what's running:**",
          "",
          "- **task:** system memory monitor",
          "- **schedule:** every 5 minutes",
          "- **command:** `free -h`",
        ].join("\n"),
      });
    });

    const frame = lastFrame() ?? "";
    expect(frame).toContain("what's running:");
    expect(frame).toContain("- task: system memory monitor");
    expect(frame).toContain("- schedule: every 5 minutes");
    expect(frame).toContain("- command: free -h");
    expect(frame).not.toContain("**what's running:**");
    expect(frame).not.toContain("`free -h`");

    await act(async () => {
      unmount();
    });
  });

  it("sends @file mentions as local CLI attachments without uploading bytes", async () => {
    const root = createTempDir();
    const reportPath = join(root, "report.txt");
    writeFileSync(reportPath, "hello", "utf8");
    const app = await renderApp();

    await writeInput(app, `Summarize @${reportPath}`);
    expect(sentChatMessages()).toHaveLength(0);

    await pressEnter(app);

    expect(websocketState.send).toHaveBeenCalledWith({
      type: "chat",
      content: `Summarize ${reportPath}`,
      attachments: [{
        source: "cli",
        path: reportPath,
        name: "report.txt",
      }],
    });
    expect(app.lastFrame() ?? "").toContain("Attachments:");
    expect(app.lastFrame() ?? "").toContain("report.txt");

    await act(async () => {
      app.unmount();
    });
  });

  it("selects a directory mention without sending until Enter is pressed again", async () => {
    const root = createTempDir();
    const docsPath = join(root, "docs");
    mkdirSync(docsPath);
    const app = await renderApp();

    await writeInput(app, `@${docsPath}`);

    expect(sentChatMessages()).toHaveLength(0);
    expect(app.lastFrame() ?? "").toContain(docsPath);

    await pressEnter(app);
    expect(websocketState.send).toHaveBeenCalledWith({
      type: "chat",
      content: [
        "Attached selected items.",
        "",
        "[selected local directories]",
        `- ${docsPath}`,
      ].join("\n"),
    });
    expect(app.lastFrame() ?? "").toContain("Attachments:");
    expect(app.lastFrame() ?? "").toContain("docs");

    await act(async () => {
      app.unmount();
    });
  });

  it("sends directory mentions as local context instead of file attachments", async () => {
    const root = createTempDir();
    const docsPath = join(root, "docs");
    mkdirSync(docsPath);
    const app = await renderApp();

    await writeInput(app, `What is missing in @${docsPath}`);
    await pressEnter(app);

    expect(websocketState.send).toHaveBeenCalledWith({
      type: "chat",
      content: `What is missing in ${docsPath}`,
    });
    expect(app.lastFrame() ?? "").toContain("Attachments:");
    expect(app.lastFrame() ?? "").toContain("docs");

    await act(async () => {
      app.unmount();
    });
  });
});
