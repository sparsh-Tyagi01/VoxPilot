import { afterEach, describe, expect, it, vi } from "vitest";
import { Planner, type PlannerLLMInterface } from "../src/offscreen/agent/planner.js";
import type { PageSnapshot } from "../src/shared/types.js";

const snapshot: PageSnapshot = {
  url: "https://example.com", title: "test", capturedAt: Date.now(), truncated: false,
  elements: [{ handle: "e0", tag: "button", label: "Submit", inViewport: true }],
};
function setup(output: unknown) {
  const planner = new Planner();
  let result!: (raw: string) => void;
  const llm: PlannerLLMInterface = {
    onResult: (_id, cb) => { result = cb; }, onError: vi.fn(), abort: vi.fn(),
    postGenerate: vi.fn(() => result(JSON.stringify(output))),
  };
  planner.setLLMInterface(llm);
  return { planner, llm };
}
const plan = (handle: string) => ({ intent: "Submit", risk: 0, requiresConfirmation: false, actions: [{ type: "click", handle }] });
afterEach(() => vi.useRealTimers());
describe("Planner safety boundaries", () => {
  it("rejects invented handles instead of choosing the first page element", async () => {
    for (const handle of ["unknown", "e999"]) {
      await expect(setup(plan(handle)).planner.plan("submit", snapshot)).rejects.toThrow(/handle/);
    }
  });
  it("escalates model risk using the real element label", async () => {
    const output = await setup(plan("e0")).planner.plan("submit", snapshot);
    expect(output.risk).toBe(3);
    expect(output.requiresConfirmation).toBe(true);
  });
  it("rejects empty plans and malformed steps instead of inventing success", async () => {
    for (const actions of [[], [null], [{ type: "click", handle: "e0" }, false]]) {
      await expect(setup({ intent: "bad", actions }).planner.plan("run", snapshot)).rejects.toThrow();
    }
  });
  it("rejects unknown action types before execution", async () => {
    await expect(setup({ intent: "bad", actions: [{ type: "shell" }] }).planner.plan("run", snapshot)).rejects.toThrow(/validation/);
  });
  it("aborts generation when the planner deadline expires", async () => {
    vi.useFakeTimers();
    const { planner, llm } = setup({});
    vi.mocked(llm.postGenerate).mockImplementation(() => {});
    const request = planner.plan("submit", snapshot);
    const assertion = expect(request).rejects.toThrow(/60 seconds/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(llm.abort).toHaveBeenCalledOnce();
  });
  it("allows an active stream beyond 30 seconds and rejects stalled streams", async () => {
    vi.useFakeTimers();
    const { planner, llm } = setup({});
    let token!: (delta: string) => void;
    llm.onToken = (_id, cb) => { token = cb; };
    vi.mocked(llm.postGenerate).mockImplementation(() => {});
    const request = planner.plan("submit", snapshot);
    const assertion = expect(request).rejects.toThrow(/stopped responding/);
    await vi.advanceTimersByTimeAsync(50_000);
    token("{");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(llm.abort).not.toHaveBeenCalled();
    token('"intent":');
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(llm.abort).toHaveBeenCalledOnce();
  });
  it("keeps form values out of model prompts and bounds page context", () => {
    const { planner } = setup({});
    const messages = planner.buildMessages("click", { ...snapshot, elements: Array.from({ length: 1000 }, (_, i) => ({
      handle: `e${i}`, tag: "input", label: "x".repeat(100), value: "secret-value", inViewport: true,
    })) });
    expect(messages[1]!.content).not.toContain("secret-value");
    expect(messages[1]!.content.length).toBeLessThan(5000);
  });
});
