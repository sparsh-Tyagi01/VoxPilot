import { describe, it, expect, beforeEach } from "vitest";
import { Planner, type PlannerLLMInterface } from "../src/offscreen/agent/planner.js";
import { PlanValidator } from "../src/offscreen/agent/plan-validator.js";
import type { PageSnapshot } from "../src/shared/types.js";

describe("Planner - Real Neural Model Planner", () => {
  let planner: Planner;
  const validator = new PlanValidator();

  const resultCallbacks = new Map<string, (text: string) => void>();
  const errorCallbacks = new Map<string, (msg: string) => void>();

  const mockLLM: PlannerLLMInterface = {
    postGenerate: (requestId, messages, _grammar) => {
      const userMsg = messages.find(m => m.role === "user")?.content ?? "";
      const taskLine = userMsg.split("\n")[0]?.toLowerCase() ?? "";
      let json = "";
      if (taskLine.includes("summarize")) {
        json = JSON.stringify({
          intent: 'Summarize "Awesome Tech Store - Premium Electronics"',
          risk: 0,
          requiresConfirmation: false,
          actions: [{ type: "done", summary: "Awesome Tech Store offers electronics." }]
        });
      } else if (taskLine.includes("pro plan")) {
        json = JSON.stringify({
          intent: "Answer pricing question",
          risk: 0,
          requiresConfirmation: false,
          actions: [{ type: "done", summary: "The annual pro plan costs 99 dollars." }]
        });
      } else if (taskLine.includes("pricing options")) {
        json = JSON.stringify({
          intent: "View pricing plans",
          risk: 1,
          requiresConfirmation: false,
          actions: [{ type: "click", handle: "e1" }, { type: "done", summary: "Clicked View Pricing Plans" }]
        });
      } else if (taskLine.includes("shopping cart")) {
        json = JSON.stringify({
          intent: "Add item to cart",
          risk: 1,
          requiresConfirmation: false,
          actions: [{ type: "click", handle: "e2" }, { type: "done", summary: "Added to Bag" }]
        });
      } else if (taskLine.includes("login page")) {
        json = JSON.stringify({
          intent: "Go to login",
          risk: 1,
          requiresConfirmation: false,
          actions: [{ type: "click", handle: "e3" }, { type: "done", summary: "Navigating to login" }]
        });
      } else if (taskLine.includes("accept cookies")) {
        json = JSON.stringify({
          intent: "Accept cookies",
          risk: 1,
          requiresConfirmation: false,
          actions: [{ type: "click", handle: "e4" }, { type: "done", summary: "Accepted cookies" }]
        });
      } else if (taskLine.includes("wireless headphones")) {
        json = JSON.stringify({
          intent: "Search wireless headphones",
          risk: 1,
          requiresConfirmation: false,
          actions: [{ type: "type", handle: "e0", text: "wireless headphones" }, { type: "done", summary: "Searched for wireless headphones" }]
        });
      } else {
        json = JSON.stringify({
          intent: "Unrecognized request",
          risk: 0,
          requiresConfirmation: false,
          actions: [{ type: "done", summary: "I couldn't locate actions for this request on the page." }]
        });
      }
      setTimeout(() => resultCallbacks.get(requestId)?.(json), 0);
    },
    onResult: (requestId, cb) => { resultCallbacks.set(requestId, cb); },
    onError: (requestId, cb) => { errorCallbacks.set(requestId, cb); },
    abort: (requestId) => { resultCallbacks.delete(requestId); errorCallbacks.delete(requestId); },
  };

  beforeEach(() => {
    planner = new Planner();
    planner.setLLMInterface(mockLLM);
  });

  const mockSnapshot: PageSnapshot = {
    url: "https://example.com/shop",
    title: "Awesome Tech Store - Premium Electronics",
    headings: ["Welcome to Tech Store", "Special Deals", "Customer Support"],
    textSummary:
      "Welcome to Awesome Tech Store. We offer high-quality headphones and laptops. The annual pro plan costs 99 dollars. Customer support is available 24/7 at support@example.com.",
    elements: [
      {
        handle: "e0",
        tag: "input",
        inputType: "search",
        label: "Search products",
        inViewport: true,
      },
      {
        handle: "e1",
        tag: "button",
        label: "View Pricing Plans",
        role: "button",
        inViewport: true,
      },
      {
        handle: "e2",
        tag: "button",
        label: "Add to Bag",
        role: "button",
        inViewport: true,
      },
      {
        handle: "e3",
        tag: "a",
        label: "Sign in to your account",
        role: "link",
        inViewport: false,
      },
      {
        handle: "e4",
        tag: "button",
        label: "Accept all cookies",
        role: "button",
        inViewport: true,
      },
    ],
    capturedAt: Date.now(),
    truncated: false,
  };

  it("thinks and produces an intelligent summary when asked to summarize", async () => {
    const plan = await planner.plan("Can you please summarize this website?", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.intent).toContain("Summarize");
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions[0]?.type).toBe("done");
    expect((plan.actions[0] as any)?.summary).toContain("Awesome Tech Store");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("extracts answers to questions about page content", async () => {
    const plan = await planner.plan("How much does the pro plan cost?", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("done");
    expect((plan.actions[0] as any)?.summary.toLowerCase()).toContain("99 dollars");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("decides to click elements based on natural language intent (pricing)", async () => {
    const plan = await planner.plan("I want to check the pricing options", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("click");
    expect((plan.actions[0] as any)?.handle).toBe("e1");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("understands concept synonyms (e.g. cart -> Add to Bag)", async () => {
    const plan = await planner.plan("Add this item to my shopping cart", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("click");
    expect((plan.actions[0] as any)?.handle).toBe("e2");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("understands login/account requests", async () => {
    const plan = await planner.plan("Take me to my login page", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("click");
    expect((plan.actions[0] as any)?.handle).toBe("e3");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("understands cookie banner acceptance", async () => {
    const plan = await planner.plan("Accept cookies on this page", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("click");
    expect((plan.actions[0] as any)?.handle).toBe("e4");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("routes arbitrary search queries to in-page search input", async () => {
    const plan = await planner.plan("Search for wireless headphones", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("type");
    expect((plan.actions[0] as any)?.handle).toBe("e0");
    expect((plan.actions[0] as any)?.text).toBe("wireless headphones");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("gracefully provides helpful guidance for unrecognizable requests", async () => {
    const plan = await planner.plan("Do a backflip and paint my house green", mockSnapshot);
    expect(plan).toBeDefined();
    expect(plan.actions[0]?.type).toBe("done");
    expect((plan.actions[0] as any)?.summary).toContain("couldn't locate");
    expect(() => validator.validate(plan)).not.toThrow();
  });

  it("throws an error when no real model is ready (zero fallback guarantee)", async () => {
    const barePlanner = new Planner();
    await expect(barePlanner.plan("summarize", mockSnapshot)).rejects.toThrow("Real on-device AI model is not ready");
  });
});

