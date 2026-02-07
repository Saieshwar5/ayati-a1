import { describe, it, expect, vi } from "vitest";
import { AgentEngine } from "../../src/engine/index.js";

describe("AgentEngine", () => {
  it("should be constructible without options", () => {
    const engine = new AgentEngine();
    expect(engine).toBeInstanceOf(AgentEngine);
  });

  it("should be constructible with options", () => {
    const engine = new AgentEngine({ onReply: vi.fn() });
    expect(engine).toBeInstanceOf(AgentEngine);
  });

  it("should log on start", () => {
    const engine = new AgentEngine();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    void engine.start();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[DEBUG]"),
      expect.stringContaining("INFO"),
      "AgentEngine started",
    );
    spy.mockRestore();
  });

  it("should log on stop", () => {
    const engine = new AgentEngine();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    void engine.stop();
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[DEBUG]"),
      expect.stringContaining("INFO"),
      "AgentEngine stopped",
    );
    spy.mockRestore();
  });

  it("should handle incoming messages", () => {
    const engine = new AgentEngine();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    engine.handleMessage("client-1", { type: "test", text: "payload" });
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[DEBUG]"),
      expect.stringContaining("INFO"),
      "Message from client-1:",
      JSON.stringify({ type: "test", text: "payload" }),
    );
    spy.mockRestore();
  });

  it("should call onReply for chat messages", () => {
    const onReply = vi.fn();
    const engine = new AgentEngine({ onReply });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    engine.handleMessage("client-1", { type: "chat", content: "Hello" });

    expect(onReply).toHaveBeenCalledOnce();
    expect(onReply).toHaveBeenCalledWith("client-1", {
      type: "reply",
      content: 'Received: "Hello"',
    });
    spy.mockRestore();
  });

  it("should not call onReply for non-chat messages", () => {
    const onReply = vi.fn();
    const engine = new AgentEngine({ onReply });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});

    engine.handleMessage("client-1", { type: "test", text: "payload" });

    expect(onReply).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
