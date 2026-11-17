import { afterEach, describe, expect, it, vi } from "vitest";
import type { SiteDecision, SiteObservation, SiteTaskState } from "../src/shared/site-task.js";
import { SiteTaskRunner } from "../src/sw/site-task-runner.js";
import { checkSitePolicy } from "../src/sw/site-policy.js";
import { parseSiteDecision } from "../src/shared/site-schema.js";
const origin = "https://shop.test";
function page(text = "Browse backpacks", overrides: Partial<SiteObservation> = {}): SiteObservation {
  return { url: origin, title: "Shop", capturedAt: 1, truncated: false, documentId: "document-1", observationId: crypto.randomUUID(), stateKey: text, textSummary: text,
    elements: [{ handle: "e1", tag: "input", inputType: "search", label: "Search", formHandle: "e2", context: "Product search", fingerprint: "query" },
      { handle: "e3", tag: "button", label: "Add to cart", context: "Blue medium shirt, £20, quantity 1", fingerprint: "product" }],
    forms: [{ handle: "e2", action: `${origin}/search`, method: "get", search: true, fingerprint: "search-form", fields: [{ name: "q", type: "search", populated: true, sensitive: false }] }],
    coverage: { candidates: 2, inspected: 2, limited: false, frames: "top_only" }, ...overrides };
}
function harness(decisions: SiteDecision[], observations = [page()]) {
  const states: SiteTaskState[] = []; let index = 0;
  const deps = {
    observe: vi.fn(async () => observations[Math.min(index++, observations.length - 1)]!),
    decide: vi.fn(async () => decisions.shift() ?? { kind: "unavailable", reason: "not_found_in_scope", message: "No further matching controls were found." } as SiteDecision),
    execute: vi.fn(async () => ({ dispatched: true, controlVerified: true, navigationExpected: false })),
    current: vi.fn(async () => true),
    publish: vi.fn(async (state: SiteTaskState) => { states.push(structuredClone(state)); }), receipt: vi.fn(async () => {}),
  };
  const runner = new SiteTaskRunner(deps);
  return { runner, deps, states, last: () => states.at(-1)! };
}
afterEach(() => vi.restoreAllMocks());
describe("site policy and decision contracts", () => {
  it("requires exact observed targets and independent approval for cart effects", () => {
    expect(checkSitePolicy({ type: "click", handle: "e999" }, page(), origin).allowed).toBe(false);
    expect(checkSitePolicy({ type: "click", handle: "e3" }, page(), origin)).toMatchObject({ allowed: true, approval: true, fingerprint: "product" });
    expect(checkSitePolicy({ type: "submit", handle: "e2" }, page(), origin)).toMatchObject({ allowed: true, approval: false });
  });
  it("rejects secret fields, unobserved navigation and cross-origin submission", () => {
    const privatePage = page(); privatePage.elements[0]!.inputType = "password";
    expect(checkSitePolicy({ type: "type", handle: "e1", text: "secret" }, privatePage, origin).allowed).toBe(false);
    expect(checkSitePolicy({ type: "navigate", url: `${origin}/invented` }, page(), origin).allowed).toBe(false);
    const other = page(); other.forms[0]!.action = "https://other.test/collect";
    expect(checkSitePolicy({ type: "submit", handle: "e2" }, other, origin).allowed).toBe(false);
  });
  it("keeps search confirmation when private/hidden fields would also be sent", () => {
    const privatePage = page(); privatePage.forms[0]!.fields.push({ name: "email", type: "hidden", sensitive: false, populated: true });
    expect(checkSitePolicy({ type: "submit", handle: "e2" }, privatePage, origin).approval).toBe(true);
  });
  it("prevents navigation and button aliases from bypassing manual commitment boundaries", () => {
    const checkout = page(); checkout.elements.push({ handle: "e4", tag: "a", label: "Buy now", href: `${origin}/checkout`, fingerprint: "checkout", context: "Immediate purchase" });
    expect(checkSitePolicy({ type: "click", handle: "e4" }, checkout, origin).allowed).toBe(false);
    expect(checkSitePolicy({ type: "navigate", url: `${origin}/checkout` }, checkout, origin).allowed).toBe(false);
    checkout.forms[0]!.submitLabels = ["Place order"];
    expect(checkSitePolicy({ type: "submit", handle: "e2" }, checkout, origin).allowed).toBe(false);
    const oversized = page(); oversized.forms[0]!.limited = true;
    expect(checkSitePolicy({ type: "submit", handle: "e2" }, oversized, origin).allowed).toBe(false);
  });
  it("rejects arbitrary scripts, extra keys, invalid handles and missing completion evidence", () => {
    for (const value of [
      { kind: "act", action: { type: "eval", code: "alert(1)" }, expected: { kind: "page_changed" } },
      { kind: "act", action: { type: "click", handle: "e1", risk: 0 }, expected: { kind: "page_changed" } },
      { kind: "act", action: { type: "click", handle: "first button" }, expected: { kind: "page_changed" } },
      { kind: "finish", message: "Done", evidence: [] },
    ]) expect(() => parseSiteDecision(JSON.stringify(value))).toThrow();
  });
});
describe("bounded observe-plan-act-verify loop", () => {
  it.each(["API key", "access token", "seed phrase", "password"])("never asks the user to dictate a %s", async secret => {
    const h = harness([{ kind: "ask", question: "Please tell me your " + secret }]);
    await h.runner.start("Set up the page", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("limited"));
    expect(h.states.some(state => state.status === "awaiting_answer")).toBe(false);
    expect(h.deps.execute).not.toHaveBeenCalled();
  });
  it("fills, explicitly submits and verifies search results through fresh observations", async () => {
    const h = harness([
      { kind: "act", action: { type: "type", handle: "e1", text: "backpacks" }, expected: { kind: "control_state" } },
      { kind: "act", action: { type: "submit", handle: "e2" }, expected: { kind: "page_changed" } },
      { kind: "finish", message: "Found backpack results.", evidence: ["Results for backpacks"] },
    ], [page(), page(), page("Results for backpacks")]);
    await h.runner.start("Find backpacks", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("completed"));
    expect(h.deps.execute).toHaveBeenCalledTimes(2);
    expect(h.deps.observe).toHaveBeenCalledTimes(3);
    expect(h.deps.receipt.mock.calls.map(call => call[3])).toEqual(["dispatched", "acknowledged", "dispatched", "acknowledged"]);
  });
  it("cannot claim a search completed after typing, including through the answer branch", async () => {
    const h = harness([
      { kind: "act", action: { type: "type", handle: "e1", text: "backpacks" }, expected: { kind: "control_state" } },
      { kind: "answer", message: "Searched successfully", evidence: ["Browse backpacks"] },
      { kind: "finish", message: "Searched successfully", evidence: ["Browse backpacks"] },
    ]);
    await h.runner.start("Search backpacks", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("limited"));
    expect(h.last().message).toContain("could not verify");
  });
  it("waits for the matching trusted approval and verifies the cart once", async () => {
    const h = harness([
      { kind: "act", action: { type: "click", handle: "e3" }, expected: { kind: "text_appeared", text: "Blue medium shirt added to cart" } },
      { kind: "finish", message: "Added the blue medium shirt.", evidence: ["Blue medium shirt added to cart"] },
    ], [page(), page("Blue medium shirt added to cart")]);
    await h.runner.start("Add the blue medium shirt", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("awaiting_approval"));
    const pending = h.last(); expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.runner.approve(pending.id, "stale", true)).toBe(false);
    expect(h.runner.approve(pending.id, pending.approval!.id, true)).toBe(true);
    expect(h.runner.approve(pending.id, pending.approval!.id, true)).toBe(false);
    await vi.waitFor(() => expect(h.last().status).toBe("completed"));
    expect(h.deps.execute).toHaveBeenCalledOnce();
  });
  it("accepts clarification, rejects stale replies and refreshes before acting", async () => {
    const h = harness([{ kind: "ask", question: "Which size?" }, { kind: "unavailable", reason: "blocked_by_site_state", message: "Medium is unavailable." }]);
    await h.runner.start("Add this shirt", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("awaiting_answer"));
    expect(h.runner.reply("wrong-task", "medium")).toBe(false);
    expect(h.runner.reply(h.last().id, "medium")).toBe(true);
    await vi.waitFor(() => expect(h.last().status).toBe("limited"));
    expect(h.last().message).toBe("Medium is unavailable.");
    expect(h.deps.observe).toHaveBeenCalledTimes(2);
  });
  it("never replays an uncertain side effect", async () => {
    const h = harness([{ kind: "act", action: { type: "click", handle: "e3" }, expected: { kind: "page_changed" } }]);
    h.deps.execute.mockRejectedValue(new Error("Lost acknowledgment"));
    await h.runner.start("Add this shirt", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("awaiting_approval"));
    h.runner.approve(h.last().id, h.last().approval!.id, true);
    await vi.waitFor(() => expect(h.last().status).toBe("unknown"));
    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(h.deps.receipt.mock.calls.at(-1)?.[3]).toBe("uncertain");
  });
  it("cancels a waiting planner without dispatching a late result", async () => {
    const h = harness([]); let resolve!: (value: SiteDecision) => void;
    h.deps.decide.mockImplementation(() => new Promise(done => { resolve = done; }));
    await h.runner.start("Find an invoice", 1, origin);
    await vi.waitFor(() => expect(h.deps.decide).toHaveBeenCalledOnce());
    h.runner.cancel();
    resolve({ kind: "act", action: { type: "click", handle: "e3" }, expected: { kind: "page_changed" } });
    await vi.waitFor(() => expect(h.last().status).toBe("cancelled"));
    expect(h.deps.execute).not.toHaveBeenCalled();
  });
  it("stops when the selected site changes after approval", async () => {
    const h = harness([{ kind: "act", action: { type: "click", handle: "e3" }, expected: { kind: "page_changed" } }]);
    await h.runner.start("Add this shirt", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("awaiting_approval"));
    h.deps.current.mockResolvedValue(false);
    h.runner.approve(h.last().id, h.last().approval!.id, true);
    await vi.waitFor(() => expect(h.last().status).toBe("limited"));
    expect(h.deps.execute).not.toHaveBeenCalled();
  });
  it("does not execute when cancellation occurs during the final asynchronous scope check", async () => {
    const h = harness([{ kind: "act", action: { type: "type", handle: "e1", text: "backpacks" }, expected: { kind: "control_state" } }]);
    let count = 0;
    h.deps.current.mockImplementation(async () => { if (++count === 4) h.runner.cancel(); return true; });
    await h.runner.start("Find backpacks", 1, origin);
    await vi.waitFor(() => expect(h.last().status).toBe("cancelled"));
    expect(h.deps.execute).not.toHaveBeenCalled();
  });
});
