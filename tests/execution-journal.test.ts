import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExecutionJournal, EXECUTION_RECEIPT_KEY } from "../src/sw/execution-journal.js";
import { executeBrowserPlan } from "../src/sw/plan-execution.js";
import { RiskTier } from "../src/shared/types.js";
let store: Record<string, unknown>;
beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", { storage: { session: {
    get: async (key: string) => structuredClone({ [key]: store[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(store, structuredClone(values)); },
  } } });
});
afterEach(() => vi.unstubAllGlobals());
it("marks a dispatched step uncertain after a restart, preserving acknowledged steps", async () => {
  const journal = new ExecutionJournal();
  await journal.begin("execution-1");
  await journal.step("execution-1", 0, "type", "acknowledged");
  await journal.step("execution-1", 1, "click", "dispatched");
  const restarted = new ExecutionJournal();
  expect(await restarted.recover()).toBe("execution-1");
  expect(await restarted.read()).toMatchObject({ status: "interrupted", steps: [
    { index: 0, kind: "type", status: "acknowledged" }, { index: 1, kind: "click", status: "uncertain" },
  ] });
  expect(await restarted.recover()).toBeNull();
});
it("persists before a page side effect and never includes action arguments in receipts", async () => {
  const journal = new ExecutionJournal(); await journal.begin("execution-2");
  const page = vi.fn(async () => {
    expect((await journal.read())?.steps[0]?.status).toBe("dispatched");
    return { type: "EXECUTION_DONE" as const, success: true };
  });
  await executeBrowserPlan(12, { intent: "Type private text", risk: RiskTier.R2, requiresConfirmation: false,
    actions: [{ type: "type", handle: "e2", text: "private field value" }],
  }, page, async () => true, "document-1", (index, kind, status) => journal.step("execution-2", index, kind, status));
  await journal.finish("execution-2", true);
  expect(await journal.read()).toMatchObject({ status: "completed", steps: [{ status: "acknowledged" }] });
  expect(JSON.stringify(store[EXECUTION_RECEIPT_KEY])).not.toMatch(/private|e2|document-1/);
  expect(page).toHaveBeenCalledOnce();
});
it("leaves a failed page action uncertain and rejects stale receipt writers", async () => {
  const journal = new ExecutionJournal(); await journal.begin("execution-3");
  await expect(executeBrowserPlan(12, { intent: "Click", risk: RiskTier.R1, requiresConfirmation: false,
    actions: [{ type: "click", handle: "e2" }],
  }, async () => null, async () => true, undefined, (index, kind, status) => journal.step("execution-3", index, kind, status))).rejects.toThrow("acknowledge");
  expect((await journal.read())?.steps[0]?.status).toBe("uncertain");
  await journal.finish("execution-3", false);
  await expect(journal.step("execution-3", 1, "click", "dispatched")).rejects.toThrow("no longer active");
});
