import { describe, it, expect, vi } from "vitest";
import { AgentEngine } from "../../src/engine/index.js";

describe("AgentEngine", () => {
  it("should be constructible", () => {
    const engine = new AgentEngine();
    expect(engine).toBeInstanceOf(AgentEngine);
  });

  it("should print hello world on start", () => {
    const engine = new AgentEngine();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    void engine.start();
    expect(spy).toHaveBeenCalledWith("Hello World from agent-engine!");
    spy.mockRestore();
  });

  it("should print stopped on stop", () => {
    const engine = new AgentEngine();
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    void engine.stop();
    expect(spy).toHaveBeenCalledWith("agent-engine stopped.");
    spy.mockRestore();
  });
});
