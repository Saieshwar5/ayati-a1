import { describe, expect, it } from "vitest";
import {
  ContextEngineObserver,
  type ContextEngineObservabilityEvent,
  isContextEngineObservabilityEvent,
  runWithContextEngineTrace,
  sanitizeObservabilityData,
} from "../src/observability.js";

describe("Context Engine observability", () => {
  it("propagates a request trace through asynchronous service work", async () => {
    const events: ContextEngineObservabilityEvent[] = [];
    const observer = new ContextEngineObserver("context-engine", (event) => events.push(event));

    await runWithContextEngineTrace("trace-1", async () => {
      await Promise.resolve();
      observer.emit({ level: "info", event: "work_completed" });
    });

    expect(events[0]).toMatchObject({ traceId: "trace-1", event: "work_completed" });
    expect(isContextEngineObservabilityEvent(events[0])).toBe(true);
  });

  it("redacts secrets and bounds raw diagnostic values", () => {
    const data = sanitizeObservabilityData({
      authorization: "Bearer private",
      apiToken: "private",
      purpose: "inspect workstream state",
      output: "x".repeat(2_100),
    });

    expect(data.authorization).toBe("[redacted]");
    expect(data.apiToken).toBe("[redacted]");
    expect(data.purpose).toBe("inspect workstream state");
    expect(String(data.output)).toContain("[truncated");
  });
});
