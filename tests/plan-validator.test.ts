import { describe, it, expect } from "vitest";
import { PlanValidator, ValidationError } from "../src/offscreen/agent/plan-validator.js";
import { RiskTier, type AgentPlan } from "../src/shared/types.js";

describe("PlanValidator (FR-SAFE-01)", () => {
  const validator = new PlanValidator();

  it("validates a compliant AgentPlan", () => {
    const validPlan: AgentPlan = {
      intent: "Search for hotels in Paris",
      risk: RiskTier.R1,
      requiresConfirmation: false,
      actions: [
        { type: "type", handle: "e1", text: "Paris hotels", clear: true },
        { type: "click", handle: "e2", label: "Search" },
        { type: "done", summary: "Searched for hotels in Paris" },
      ],
    };

    const validated = validator.validate(validPlan);
    expect(validated).toEqual(validPlan);
  });

  it("throws ValidationError when intent is missing", () => {
    const invalidPlan = {
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [{ type: "done", summary: "Done" }],
    };

    expect(() => validator.validate(invalidPlan)).toThrow(ValidationError);
  });

  it("throws ValidationError when action type is unknown", () => {
    const invalidPlan = {
      intent: "Hack the mainframe",
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [{ type: "exec_arbitrary_shell_command", cmd: "rm -rf /" }],
    };

    expect(() => validator.validate(invalidPlan)).toThrow(ValidationError);
  });

  it("throws ValidationError when risk tier is out of range", () => {
    const invalidPlan = {
      intent: "Invalid risk tier",
      risk: 99,
      requiresConfirmation: false,
      actions: [{ type: "done", summary: "Done" }],
    };

    expect(() => validator.validate(invalidPlan)).toThrow(ValidationError);
  });
});



describe("Browser command allowlist", () => {
  const validator = new PlanValidator();
  const plan = (action: unknown) => ({ intent: "browser", risk: 1, requiresConfirmation: false, actions: [action] });
  it("accepts fixed browser navigation tokens and rejects executable URLs", () => {
    for (const url of ["javascript:history.back()", "javascript:history.forward()", "javascript:location.reload()", "https://example.com"]) {
      expect(() => validator.validate(plan({ type: "navigate", url }))).not.toThrow();
    }
    for (const url of ["javascript:alert(1)", "javascript:history.back();alert(1)", "data:text/html,test"]) {
      expect(() => validator.validate(plan({ type: "navigate", url }))).toThrow();
      expect(() => validator.validate(plan({ type: "tab", operation: "open", url }))).toThrow();
    }
  });
  it("accepts the actual router's previous-tab and end-of-page actions", () => {
    expect(() => validator.validate(plan({ type: "tab", operation: "switch", index: -1 }))).not.toThrow();
    expect(() => validator.validate(plan({ type: "scroll", direction: "down", amount: 99999 }))).not.toThrow();
  });
});
