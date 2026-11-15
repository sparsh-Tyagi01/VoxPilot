import { SnapshotBuilder } from "../../src/content/snapshot.js";
import { observeSite, waitForSiteObservation } from "../../src/content/site-observation.js";
import { executeSiteAction } from "../../src/content/site-executor.js";
import { SiteTaskRunner } from "../../src/sw/site-task-runner.js";
import { checkSitePolicy } from "../../src/sw/site-policy.js";
import type { SiteDecision, SiteObservation, SiteTaskState } from "../../src/shared/site-task.js";
import { parseSiteDecision } from "../../src/shared/site-schema.js";
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
document.body.innerHTML = `<main><h1>Fixture store</h1>
  <form role="search" action="/search" method="get"><label>Search products <input type="search" name="q"></label><button type="submit">Search</button></form>
  <p id="results">Browse our products</p>
  <form id="product"><h2>Blue shirt, £20</h2><label>Size <select name="size"><option>Small</option><option>Medium</option></select></label>
  <label>Quantity <input name="quantity" type="number" value="1"></label><button id="add" type="button">Add to cart</button></form>
  <p id="cart">Cart is empty</p><form><label>Password <input name="password" type="password"></label></form></main>`;
const input = document.querySelector<HTMLInputElement>("input[type=search]")!;
document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); setTimeout(() => { document.getElementById("results")!.textContent = `Results for ${input.value}`; }, 75); });
let additions = 0;
document.getElementById("add")!.addEventListener("click", () => { additions++; document.getElementById("cart")!.textContent = "Blue medium shirt quantity 1 added to cart"; });
const builder = new SnapshotBuilder();
const cases: string[] = [];
const origin = location.origin;
async function run(goal: string, decide: (page: SiteObservation, index: number) => SiteDecision): Promise<SiteTaskState> {
  let index = 0;
  let resolve!: (state: SiteTaskState) => void;
  const terminal = new Promise<SiteTaskState>(done => { resolve = done; });
  const runner = new SiteTaskRunner({
    observe: async (_tabId, after) => waitForSiteObservation(builder, after?.stateKey),
    decide: async request => decide(request.observation, index++),
    execute: async (_tabId, action, page, fingerprint) => executeSiteAction(builder, action, page.documentId, fingerprint),
    current: async () => true, receipt: async () => {},
    publish: async state => {
      if (state.status === "awaiting_approval") queueMicrotask(() => runner.approve(state.id, state.approval!.id, true));
      if (["completed", "answered", "limited", "unknown", "cancelled"].includes(state.status)) resolve(state);
    },
  });
  await runner.start(goal, 1, origin);
  return terminal;
}
try {
  assert(parseSiteDecision('{"kind":"ask","question":"Which size?"}').kind === "ask", "CSP-safe schema validation failed");
  cases.push("decision validation under restrictive CSP without runtime code generation");
  const search = await run("Find backpacks", (page, step) => step === 0
    ? { kind: "act", action: { type: "type", handle: page.elements.find(el => el.inputType === "search")!.handle, text: "backpacks" }, expected: { kind: "control_state" } }
    : step === 1 ? { kind: "act", action: { type: "submit", handle: page.forms.find(form => form.search)!.handle }, expected: { kind: "text_appeared", text: "Results for backpacks" } }
      : { kind: "finish", message: "Found backpack results.", evidence: ["Results for backpacks"] });
  assert(search.status === "completed" && input.value === "backpacks", `Search failed: ${search.message}`);
  cases.push("real form fill, explicit submission, async result verification");

  const snapshot = observeSite(builder);
  const add = snapshot.elements.find(el => el.label === "Add to cart")!;
  const policy = checkSitePolicy({ type: "click", handle: add.handle }, snapshot, origin);
  assert(policy.approval, "Cart operation did not require approval");
  const quantity = document.querySelector<HTMLInputElement>("input[name=quantity]")!;
  quantity.value = "5";
  let rejected = false;
  try { await executeSiteAction(builder, { type: "click", handle: add.handle }, snapshot.documentId, policy.fingerprint); }
  catch { rejected = true; }
  assert(rejected && additions === 0, "Changed quantity reused a stale approval");
  cases.push("quantity changes invalidate target fingerprint before dispatch");
  quantity.value = "1";

  const cart = await run("Add one blue medium shirt", (page, step) => step === 0
    ? { kind: "act", action: { type: "select", handle: page.elements.find(el => el.tag === "select")!.handle, option: "Medium" }, expected: { kind: "control_state" } }
    : step === 1 ? { kind: "act", action: { type: "click", handle: page.elements.find(el => el.label === "Add to cart")!.handle }, expected: { kind: "text_appeared", text: "Blue medium shirt quantity 1 added to cart" } }
      : { kind: "finish", message: "Added one blue medium shirt.", evidence: ["Blue medium shirt quantity 1 added to cart"] });
  assert(cart.status === "completed" && additions === 1, `Cart failed: ${cart.message}`);
  cases.push("variant selection, approval and single cart mutation with verification");

  document.querySelector<HTMLInputElement>("input[type=password]")!.value = "secret-value-never-export";
  const privatePage = observeSite(builder);
  assert(!JSON.stringify(privatePage).includes("secret-value-never-export"), "Password leaked into observation");
  cases.push("sensitive field values excluded from observations");
  let stale = false;
  try { await executeSiteAction(builder, { type: "click", handle: privatePage.elements[0]!.handle }, "another-document", ""); } catch { stale = true; }
  assert(stale, "Document binding failed");
  cases.push("stale document rejected");
  builder.dispose();
  Object.assign(window, { smokeResult: { ok: true, cases } });
} catch (error) { Object.assign(window, { smokeResult: { ok: false, error: String(error), cases } }); }
