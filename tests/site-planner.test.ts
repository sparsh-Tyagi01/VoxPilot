import { afterEach, expect, it, vi } from "vitest";
import { decideSiteStep } from "../src/offscreen/agent/site-planner.js";
import type { PlannerLLMInterface } from "../src/offscreen/agent/planner.js";
import type { SiteDecisionRequest } from "../src/shared/site-task.js";
const request = (): SiteDecisionRequest => ({ taskId: "task", goal: "Find a shirt", answers: [], history: [], remainingMs: 120_000,
  observation: { url: "https://shop.test", title: "Shop", documentId: "doc", observationId: "obs", stateKey: "key", capturedAt: 1, truncated: false,
    elements: [{ handle: "e1", tag: "input", label: "Search", context: "Product search", fingerprint: "private-fingerprint", value: "private-field-value" }], forms: [], coverage: { candidates: 1, inspected: 1, limited: false, frames: "top_only" } } });
function engine() {
  let result!: (value: string) => void;
  let token!: (value: string) => void;
  const llm: PlannerLLMInterface = { postGenerate: vi.fn(), onResult: (_id, callback) => { result = callback; }, onError: vi.fn(), onToken: (_id, callback) => { token = callback; }, abort: vi.fn() };
  return { llm, result: (value: unknown) => result(JSON.stringify(value)), token: () => token("{") };
}
afterEach(() => vi.useRealTimers());
it("sends a serialized one-decision grammar and excludes field values/fingerprints", async () => {
  const e = engine(); const pending = decideSiteStep(e.llm, request());
  const call = vi.mocked(e.llm.postGenerate).mock.calls[0]!;
  expect(typeof call[2]).toBe("string"); expect(JSON.parse(call[2]!)).toHaveProperty("anyOf");
  const prompt = JSON.stringify(call[1]);
  expect(prompt).toContain("USER GOAL"); expect(prompt).toContain("UNTRUSTED");
  expect(prompt).not.toMatch(/private-fingerprint|private-field-value/);
  e.result({ kind: "ask", question: "Which size?" });
  expect(await pending).toEqual({ kind: "ask", question: "Which size?" });
});
it("rejects invalid model tools before they can reach the coordinator", async () => {
  const e = engine(); const pending = decideSiteStep(e.llm, request());
  e.result({ kind: "act", action: { type: "eval", code: "arbitrary()" }, expected: { kind: "page_changed" } });
  await expect(pending).rejects.toThrow("invalid next-step");
});
it("converts compact CPU requests and retains private-value filtering", async () => {
  const e = engine(); e.llm.backend = "wasm";
  const pending = decideSiteStep(e.llm, request());
  const messages = vi.mocked(e.llm.postGenerate).mock.calls[0]![1];
  expect(messages.length).toBeLessThanOrEqual(8);
  expect(JSON.stringify(messages)).not.toMatch(/private-fingerprint|private-field-value/);
  e.result({ tool: "type", target: "e1", value: "shirt" });
  expect(await pending).toMatchObject({ kind: "act", action: { type: "type", handle: "e1", text: "shirt" } });
  expect(e.llm.abort).not.toHaveBeenCalled();
});
it("rejects malformed CPU decisions without discarding the warm worker", async () => {
  const e = engine(); e.llm.backend = "wasm";
  const pending = decideSiteStep(e.llm, request());
  e.result({ tool: "click", target: "invented" });
  await expect(pending).rejects.toThrow("invalid target");
  expect(e.llm.abort).not.toHaveBeenCalled();
});
it("cancels a token-stalled decision within the task's remaining budget", async () => {
  vi.useFakeTimers(); const e = engine(); const pending = decideSiteStep(e.llm, { ...request(), remainingMs: 30_000 });
  const rejection = expect(pending).rejects.toThrow("stopped responding");
  await vi.advanceTimersByTimeAsync(5000); e.token(); await vi.advanceTimersByTimeAsync(20_000);
  await rejection; expect(e.llm.abort).toHaveBeenCalledOnce();
});
