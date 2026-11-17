import { HostedPlanner } from "../../src/sw/hosted-planner.js";
import { SnapshotBuilder } from "../../src/content/snapshot.js";
import { waitForSiteObservation } from "../../src/content/site-observation.js";
import { executeSiteAction } from "../../src/content/site-executor.js";
import { SiteTaskRunner } from "../../src/sw/site-task-runner.js";
import type { SiteTaskState } from "../../src/shared/site-task.js";
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
document.body.innerHTML = '<main><h1>Fixture store</h1><form role="search"><label>Search products <input type="search" name="q"></label><button type="submit">Search</button></form><p id="results">Browse products</p><form><label>Size <select><option>Small</option><option>Medium</option></select></label><button id="cart-button" type="button">Add to cart</button></form><p id="cart">Cart is empty</p></main>';
document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); document.getElementById("results")!.textContent = "Results for backpacks"; });
let cartAdds = 0, approvals = 0;
document.getElementById("cart-button")!.addEventListener("click", () => { cartAdds++; document.getElementById("cart")!.textContent = "One medium shirt added to cart"; });
const builder = new SnapshotBuilder(); const cases: string[] = [];
let model = "fixture-search";
const planner = new HostedPlanner(async () => ({ config: { version: 1, enabled: true, endpoint: location.origin + "/provider/v1/chat/completions", model }, apiKey: "synthetic-key" }));
async function run(goal: string): Promise<SiteTaskState> {
  let resolve!: (value: SiteTaskState) => void;
  const done = new Promise<SiteTaskState>(finish => { resolve = finish; });
  const runner = new SiteTaskRunner({
    observe: async (_tab, after) => waitForSiteObservation(builder, after?.stateKey),
    decide: request => planner.decide(request, () => runner.isPlanning(request.taskId)),
    cancelDecision: () => planner.cancel(), current: async () => true, receipt: async () => {},
    execute: async (_tab, action, observation, fingerprint) => executeSiteAction(builder, action, observation.documentId, fingerprint),
    publish: async state => {
      if (state.status === "awaiting_approval") { approvals++; queueMicrotask(() => runner.approve(state.id, state.approval!.id, true)); }
      if (["completed", "answered", "limited", "unknown", "cancelled"].includes(state.status)) resolve(state);
    },
  });
  await runner.start(goal, 1, location.origin); return done;
}
try {
  const search = await run("Find backpacks");
  assert(search.status === "completed", search.message);
  assert(document.querySelector<HTMLInputElement>("input")!.value === "backpacks", "Hosted decision did not fill the observed search field");
  cases.push("real hosted HTTP request, native field entry, explicit form submission and result verification");
  model = "fixture-cart"; const cart = await run("Add one medium shirt");
  assert(cart.status === "completed" && cartAdds === 1 && approvals === 1, "Hosted cart flow bypassed approval or duplicated an action");
  cases.push("hosted cart decisions retain operation approval and single DOM activation");
  model = "fixture-invalid"; const invalid = await run("Try an unsupported tool");
  assert(invalid.status === "limited" && cartAdds === 1, "Invalid hosted tool escaped schema validation");
  cases.push("invalid hosted tools are rejected before execution");
  model = "fixture-delayed";
  const pending = planner.decide({ taskId: "cancel", goal: "Wait", observation: await waitForSiteObservation(builder), history: [], answers: [], remainingMs: 5000 }, () => true);
  setTimeout(() => planner.cancel(), 20);
  let cancelled = false; try { await pending; } catch (error) { cancelled = error instanceof DOMException && error.name === "AbortError"; }
  assert(cancelled, "Stop did not abort the live hosted HTTP request");
  cases.push("Stop aborts an in-flight hosted request");
  Object.assign(window, { smokeResult: { ok: true, provider: "scripted local HTTP fixture, not a real model", cases } });
} catch (error) { Object.assign(window, { smokeResult: { ok: false, error: String(error), cases } }); }
finally { builder.dispose(); planner.cancel(); }
