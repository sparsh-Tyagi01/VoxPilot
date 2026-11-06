import { describe, it, expect } from "vitest";
import { RiskClassifier } from "../src/offscreen/agent/risk-classifier.js";
import { RiskTier, type AgentPlan } from "../src/shared/types.js";

describe("RiskClassifier (FR-SAFE-01, FR-SAFE-02)", () => {
  const classifier = new RiskClassifier();

  it("classifies pure read/scroll plans as R0", () => {
    const plan: AgentPlan = {
      intent: "Read page",
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [
        { type: "scroll", handle: null, direction: "down" },
        { type: "read", handle: null },
        { type: "done", summary: "Done" },
      ],
    };

    expect(classifier.classify(plan)).toBe(RiskTier.R0);
  });

  it("classifies single text input as R1", () => {
    const plan: AgentPlan = {
      intent: "Type query",
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [
        { type: "type", handle: "e1", text: "hello" },
        { type: "done", summary: "Done" },
      ],
    };

    expect(classifier.classify(plan)).toBe(RiskTier.R1);
  });

  it("escalates multi-field typing to R2", () => {
    const plan: AgentPlan = {
      intent: "Fill two fields",
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [
        { type: "type", handle: "e1", text: "first name" },
        { type: "type", handle: "e2", text: "last name" },
        { type: "done", summary: "Done" },
      ],
    };

    expect(classifier.classify(plan)).toBe(RiskTier.R2);
  });

  it("escalates submit buttons to R3", () => {
    const plan: AgentPlan = {
      intent: "Submit form",
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [
        { type: "click", handle: "e3", label: "Submit" },
        { type: "done", summary: "Done" },
      ],
    };

    expect(classifier.classify(plan)).toBe(RiskTier.R3);
  });

  it("escalates vault fill actions to R3", () => {
    const plan: AgentPlan = {
      intent: "Fill password from vault",
      risk: RiskTier.R0,
      requiresConfirmation: false,
      actions: [
        { type: "fill_from_vault", handle: "e4", vaultField: "password" },
        { type: "done", summary: "Done" },
      ],
    };

    expect(classifier.classify(plan)).toBe(RiskTier.R3);
  });

  it("escalates to R4 on payment / checkout URLs", () => {
    const plan: AgentPlan = {
      intent: "Click button on checkout page",
      risk: RiskTier.R1,
      requiresConfirmation: false,
      actions: [
        { type: "click", handle: "e5", label: "Continue" },
        { type: "done", summary: "Done" },
      ],
    };

    expect(classifier.classify(plan, "https://example.com/cart/checkout")).toBe(RiskTier.R4);
    expect(classifier.classify(plan, "https://bank.com/transfer/funds")).toBe(RiskTier.R4);
  });

  it("never de-escalates a risk tier reported by the LLM", () => {
    const plan: AgentPlan = {
      intent: "Read page but LLM flagged R3",
      risk: RiskTier.R3,
      requiresConfirmation: true,
      actions: [{ type: "read", handle: null }],
    };

    expect(classifier.classify(plan)).toBe(RiskTier.R3);
  });
});
