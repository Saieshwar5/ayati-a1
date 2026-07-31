import { describe, expect, it } from "vitest";
import {
  createBindingAttemptPolicyState,
  recordBindingAttempt,
} from "../../src/ivec/agent-runner/binding-attempt-policy.js";

describe("binding attempt policy", () => {
  it("allows one correction after a proven no-change rejection", () => {
    const initial = createBindingAttemptPolicyState();
    const first = recordBindingAttempt(initial, false);

    expect(first).toEqual({
      attempts: 1,
      unavailable: false,
    });

    const corrected = recordBindingAttempt(first, true);
    expect(corrected).toEqual({
      attempts: 2,
      unavailable: true,
    });
  });

  it("closes binding after two proven no-change rejections", () => {
    const first = recordBindingAttempt(
      createBindingAttemptPolicyState(),
      false,
    );
    const second = recordBindingAttempt(first, false);

    expect(second).toEqual({
      attempts: 2,
      unavailable: true,
    });
  });

  it("closes binding immediately after a consumed attempt", () => {
    const state = recordBindingAttempt(
      createBindingAttemptPolicyState(),
      true,
    );

    expect(state).toEqual({
      attempts: 1,
      unavailable: true,
    });
  });
});
