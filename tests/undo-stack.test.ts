import { describe, it, expect } from "vitest";
import { UndoStack } from "../src/offscreen/agent/undo-stack.js";
import { RiskTier, type AgentPlan } from "../src/shared/types.js";

describe("UndoStack (FR-SAFE-03)", () => {
  it("pushes and pops reversible plans (R0–R2)", () => {
    const stack = new UndoStack();

    const plan: AgentPlan = {
      intent: "Type query",
      risk: RiskTier.R1,
      requiresConfirmation: false,
      actions: [{ type: "type", handle: "e1", text: "Paris" }],
    };

    stack.push(plan, 101);
    expect(stack.size).toBe(1);

    const peeked = stack.peek();
    expect(peeked?.plan.intent).toBe("Type query");
    expect(peeked?.tabId).toBe(101);

    const undone = stack.undo();
    expect(undone?.plan.intent).toBe("Type query");
    expect(undone?.undone).toBe(true);

    // After undo, peek should return null
    expect(stack.peek()).toBeNull();
  });

  it("ignores high-risk plans (R3/R4) to prevent unsafe reversals", () => {
    const stack = new UndoStack();

    const dangerousPlan: AgentPlan = {
      intent: "Confirm payment",
      risk: RiskTier.R4,
      requiresConfirmation: true,
      actions: [{ type: "click", handle: "e99", label: "Pay $1000" }],
    };

    stack.push(dangerousPlan, 102);
    expect(stack.size).toBe(0);
    expect(stack.peek()).toBeNull();
  });

  it("builds correct inverse actions for typing, toggling, and scrolling", () => {
    const stack = new UndoStack();

    const plan: AgentPlan = {
      intent: "Fill and scroll",
      risk: RiskTier.R2,
      requiresConfirmation: false,
      actions: [
        { type: "type", handle: "e1", text: "text to clear" },
        { type: "toggle", handle: "e2", checked: true },
        { type: "scroll", handle: null, direction: "down", amount: 400 },
      ],
    };

    stack.push(plan, 103);
    const entry = stack.peek()!;
    const inverses = stack.buildInverseActions(entry);

    expect(inverses).toHaveLength(3);
    expect(inverses[0]).toEqual({ type: "type", handle: "e1", text: "", clear: true });
    expect(inverses[1]).toEqual({ type: "toggle", handle: "e2", checked: false });
    expect(inverses[2]).toEqual({ type: "scroll", handle: null, direction: "up", amount: 400 });
  });
});

