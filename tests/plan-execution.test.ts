import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { executeBrowserPlan } from "../src/sw/plan-execution.js";
import type { AgentAction, AgentPlan } from "../src/shared/types.js";

const makePlan = (actions: AgentAction[]): AgentPlan => ({ intent: "test", actions, risk: 1, requiresConfirmation: false });
let tabs: {
  update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>; reload: ReturnType<typeof vi.fn>;
};
beforeEach(() => {
  tabs = {
    update: vi.fn(async () => undefined), create: vi.fn(async () => undefined), remove: vi.fn(async () => undefined),
    get: vi.fn(async () => ({ id: 12, windowId: 3 })),
    query: vi.fn(async () => [{ id: 24, index: 1 }, { id: 12, index: 0 }]),
    goBack: vi.fn(async () => undefined), goForward: vi.fn(async () => undefined), reload: vi.fn(async () => undefined),
  };
  vi.stubGlobal("chrome", { tabs });
});
afterEach(() => vi.unstubAllGlobals());

describe("browser plan execution", () => {
  it("preserves DOM/navigation order and executes each DOM step once", async () => {
    const operations: string[] = [];
    tabs.update.mockImplementation(async () => { operations.push("navigate"); });
    const sendToPage = vi.fn(async (_tab: number, message: { plan: AgentPlan }) => {
      operations.push(message.plan.actions[0]!.type);
      return { type: "EXECUTION_DONE" as const, success: true };
    });
    await executeBrowserPlan(12, makePlan([
      { type: "click", handle: "e1" }, { type: "navigate", url: "https://example.com/next" },
      { type: "read" }, { type: "done", summary: "Done" },
    ]), sendToPage);
    expect(operations).toEqual(["click", "navigate", "read"]);
    expect(sendToPage).toHaveBeenCalledTimes(2);
    expect(sendToPage.mock.calls.every(([tab, message]) => tab === 12 && message.plan.actions.length === 1)).toBe(true);
  });

  it("fails immediately when a page action rejects, without retrying or proceeding", async () => {
    const sendToPage = vi.fn(async () => ({ type: "EXECUTION_DONE" as const, success: false, error: "Element no longer exists" }));
    await expect(executeBrowserPlan(12, makePlan([
      { type: "click", handle: "e1" }, { type: "navigate", url: "https://example.com" },
    ]), sendToPage)).rejects.toThrow("Element no longer exists");
    expect(sendToPage).toHaveBeenCalledOnce();
    expect(tabs.update).not.toHaveBeenCalled();
  });

  it("requires a positive acknowledgement rather than assuming a missing response succeeded", async () => {
    await expect(executeBrowserPlan(12, makePlan([{ type: "click", handle: "e1" }]), async () => null)).rejects.toThrow("acknowledge");
  });

  it("recognizes only exact built-in history commands and treats URL text as a URL", async () => {
    await executeBrowserPlan(12, makePlan([
      { type: "navigate", url: "javascript:history.back()" },
      { type: "navigate", url: "https://example.com/history.back" },
    ]), vi.fn());
    expect(tabs.goBack).toHaveBeenCalledExactlyOnceWith(12);
    expect(tabs.update).toHaveBeenCalledExactlyOnceWith(12, { url: "https://example.com/history.back" });
    await expect(executeBrowserPlan(12, makePlan([{ type: "navigate", url: "javascript:alert('unsafe')" }]), vi.fn())).rejects.toThrow("HTTP(S)");
  });

  it("closes the bound command tab and wraps previous-tab navigation within its window", async () => {
    await executeBrowserPlan(12, makePlan([{ type: "tab", operation: "close" }]), vi.fn());
    expect(tabs.remove).toHaveBeenCalledExactlyOnceWith(12);
    await executeBrowserPlan(12, makePlan([{ type: "tab", operation: "switch", index: -1 }]), vi.fn());
    expect(tabs.query).toHaveBeenCalledWith({ windowId: 3 });
    expect(tabs.update).toHaveBeenCalledWith(24, { active: true });
  });

  it("stops before the next action when a microphone pause cancels the command", async () => {
    let active = true;
    const sendToPage = vi.fn(async () => {
      active = false;
      return { type: "EXECUTION_DONE" as const, success: true };
    });
    await expect(executeBrowserPlan(12, makePlan([
      { type: "click", handle: "e1" }, { type: "navigate", url: "https://example.com" },
    ]), sendToPage, async () => active)).rejects.toThrow("cancelled");
    expect(sendToPage).toHaveBeenCalledOnce();
    expect(tabs.update).not.toHaveBeenCalled();
  });

  it("blocks script URLs for new tabs", async () => {
    await expect(executeBrowserPlan(12, makePlan([{ type: "tab", operation: "open", url: "javascript:alert(1)" }]), vi.fn())).rejects.toThrow("webpages");
    expect(tabs.create).not.toHaveBeenCalled();
  });
});
