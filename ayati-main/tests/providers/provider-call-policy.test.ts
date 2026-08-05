import { describe, expect, it } from "vitest";
import {
  classifyProviderFailure,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  getProviderRequestOptions,
  ProviderCallError,
  readProviderRequestTimeoutMs,
  toProviderCallError,
} from "../../src/providers/shared/provider-call-policy.js";

describe("provider call policy", () => {
  it("uses one explicit bounded request and disables SDK retries", () => {
    expect(getProviderRequestOptions({})).toEqual({
      timeout: DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
    });
    expect(getProviderRequestOptions({ AYATI_LLM_REQUEST_TIMEOUT_MS: "45000" })).toEqual({
      timeout: 45_000,
      maxRetries: 0,
    });
    expect(() => readProviderRequestTimeoutMs({ AYATI_LLM_REQUEST_TIMEOUT_MS: "0" }))
      .toThrow("AYATI_LLM_REQUEST_TIMEOUT_MS must be an integer between 1000 and 600000.");
  });

  it("classifies timeouts and temporary server failures as retryable", () => {
    const timeout = Object.assign(new Error("Request timed out."), {
      name: "APIConnectionTimeoutError",
    });
    const unavailable = Object.assign(new Error("Service unavailable"), {
      status: 503,
      headers: new Headers({ "retry-after": "12" }),
    });

    expect(classifyProviderFailure(timeout, "fireworks")).toMatchObject({
      provider: "fireworks",
      kind: "transient",
      retryable: true,
      errorName: "APIConnectionTimeoutError",
      retryDelayMs: 400,
    });
    expect(classifyProviderFailure(unavailable, "openrouter")).toMatchObject({
      provider: "openrouter",
      kind: "transient",
      retryable: true,
      status: 503,
      retryDelayMs: 5_000,
    });
  });

  it("does not retry account, authentication, cancellation, or unknown failures", () => {
    const quota = Object.assign(new Error("Account spending limit reached"), { status: 429 });
    const authentication = Object.assign(new Error("Invalid API key"), { status: 401 });
    const cancelled = Object.assign(new Error("Request aborted"), { name: "APIUserAbortError" });

    expect(classifyProviderFailure(quota, "fireworks")).toMatchObject({
      kind: "permanent",
      retryable: false,
      status: 429,
    });
    expect(classifyProviderFailure(authentication, "openai")).toMatchObject({
      kind: "permanent",
      retryable: false,
      status: 401,
    });
    expect(classifyProviderFailure(cancelled, "anthropic")).toMatchObject({
      kind: "cancelled",
      retryable: false,
    });
    expect(classifyProviderFailure(new Error("Unexpected adapter failure"), "openrouter"))
      .toMatchObject({ kind: "unknown", retryable: false });
  });

  it("wraps a raw failure without losing its normalized details or cause", () => {
    const raw = Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
    const normalized = toProviderCallError(raw, "fireworks");

    expect(normalized).toBeInstanceOf(ProviderCallError);
    expect(normalized.cause).toBe(raw);
    expect(normalized.details).toMatchObject({
      provider: "fireworks",
      kind: "transient",
      retryable: true,
      code: "ECONNRESET",
    });
  });
});
