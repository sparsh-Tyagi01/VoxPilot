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
