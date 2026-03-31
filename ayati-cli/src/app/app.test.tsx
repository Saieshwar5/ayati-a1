import React, { act } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "./types.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

const websocketState = vi.hoisted(() => ({
  onMessage: null as null | ((data: ServerMessage | Record<string, unknown>) => void),
  send: vi.fn(),
}));

vi.mock("./hooks/use-websocket.js", () => ({
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

import { App } from "./app.js";

type RenderedApp = ReturnType<typeof render>;

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

describe("App", () => {
  afterEach(() => {
    websocketState.onMessage = null;
    websocketState.send.mockReset();
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
});
