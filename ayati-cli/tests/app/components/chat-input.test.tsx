import React, { act, useEffect, useState } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ChatInput } from "../../../src/app/components/chat-input.js";

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

let setHarnessValue: ((value: string) => void) | null = null;

function ControlledChatInput({
  initialValue,
  onSubmit,
  width,
}: {
  readonly initialValue: string;
  readonly onSubmit: (value: string) => void;
  readonly width?: number;
}): React.JSX.Element {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    setHarnessValue = setValue;
    return () => {
      setHarnessValue = null;
    };
  }, []);

  return (
    <ChatInput
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      isLoading={false}
      width={width}
    />
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

describe("ChatInput", () => {
  it("accepts the selected suggestion instead of submitting when suggestions are visible", async () => {
    const onAcceptSuggestion = vi.fn();
    const onSubmit = vi.fn();
    const app = render(
      <ChatInput
        value="@rep"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        isLoading={false}
        suggestionsVisible
        onAcceptSuggestion={onAcceptSuggestion}
      />,
    );

    await act(async () => {
      app.stdin.write("\r");
    });

    expect(onAcceptSuggestion).toHaveBeenCalledWith({ finalizeDirectory: true });
    expect(onSubmit).not.toHaveBeenCalled();

    app.unmount();
  });

  it("submits with Enter when suggestions are not visible", async () => {
    const onSubmit = vi.fn();
    const app = render(
      <ChatInput
        value="hello"
        onChange={vi.fn()}
        onSubmit={onSubmit}
        isLoading={false}
      />,
    );

    await act(async () => {
      app.stdin.write("\r");
    });

    expect(onSubmit).toHaveBeenCalledWith("hello");

    app.unmount();
  });

  it("keeps the cursor at the end after an external suggestion insert", async () => {
    const onSubmit = vi.fn();
    const app = render(
      <ControlledChatInput
        initialValue="@rep"
        onSubmit={onSubmit}
      />,
    );

    await act(async () => {
      setHarnessValue?.("@./report.txt ");
    });
    await act(async () => {
      app.stdin.write("summarize");
    });
    await act(async () => {
      app.stdin.write("\r");
    });

    expect(onSubmit).toHaveBeenCalledWith("@./report.txt summarize");

    app.unmount();
  });

  it("keeps long pasted input inside a fixed-width composer", async () => {
    const app = render(
      <ControlledChatInput
        initialValue=""
        onSubmit={vi.fn()}
        width={32}
      />,
    );

    await act(async () => {
      app.stdin.write("x".repeat(120));
    });

    const frame = stripAnsi(app.lastFrame() ?? "");
    const longestLine = Math.max(...frame.split("\n").map((line) => line.length));
    expect(longestLine).toBeLessThanOrEqual(32);

    app.unmount();
  });
});
