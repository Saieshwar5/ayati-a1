import { describe, expect, it } from "vitest";
import {
  GitContextObserver,
  type GitContextObservabilityEvent,
  isGitContextObservabilityEvent,
  runWithGitContextTrace,
  sanitizeObservabilityData,
} from "../src/observability.js";

describe("Git Context observability", () => {
  it("propagates a request trace through asynchronous service work", async () => {
    const events: GitContextObservabilityEvent[] = [];
    const observer = new GitContextObserver("git-context-engine", (event) => events.push(event));

    await runWithGitContextTrace("trace-1", async () => {
      await Promise.resolve();
      observer.emit({ level: "info", event: "work_completed" });
    });

    expect(events[0]).toMatchObject({ traceId: "trace-1", event: "work_completed" });
    expect(isGitContextObservabilityEvent(events[0])).toBe(true);
  });

  it("redacts secrets and bounds raw diagnostic values", () => {
    const data = sanitizeObservabilityData({
      authorization: "Bearer private",
      apiToken: "private",
      purpose: "inspect task state",
      output: "x".repeat(2_100),
    });

    expect(data.authorization).toBe("[redacted]");
    expect(data.apiToken).toBe("[redacted]");
    expect(data.purpose).toBe("inspect task state");
    expect(String(data.output)).toContain("[truncated");
  });
});
