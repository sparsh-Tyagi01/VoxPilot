import { expect, it } from "vitest";
import { parseCpuDecision } from "../src/shared/cpu-decision.js";
import { parseSiteDecision } from "../src/shared/site-schema.js";

const parse = (value: unknown) => parseSiteDecision(JSON.stringify(parseCpuDecision(JSON.stringify(value))));
it("converts generic CPU tools without guessing targets, values or completion", () => {
  expect(parse({ tool: "type", target: "e123", value: "blue running shoes" })).toEqual({ kind: "act", action: { type: "type", handle: "e123", text: "blue running shoes", clear: true }, expected: { kind: "control_state" } });
  expect(parse({ tool: "submit", target: "e9" })).toEqual({ kind: "act", action: { type: "submit", handle: "e9" }, expected: { kind: "page_changed" } });
  expect(parse({ tool: "toggle", target: "e4", checked: false })).toMatchObject({ action: { checked: false } });
  expect(parse({ tool: "ask", message: "Which size?" })).toEqual({ kind: "ask", question: "Which size?" });
  expect(parse({ tool: "unavailable", message: "The inspected page has no cart control." })).toMatchObject({ kind: "unavailable", reason: "not_found_in_scope" });
});
it.each([
  null, [], { tool: "eval", code: "alert(1)" }, { tool: "click", target: "Sign in" },
  { tool: "click", target: "e1", approved: true }, { tool: "toggle", target: "e1", checked: "false" },
  { tool: "scroll", direction: "diagonal" }, { tool: "type", target: "e1", value: "" },
  { tool: "finish", message: "Added!", evidence: [] }, { tool: "answer", message: "Answer", evidence: ["short"] },
])("rejects invalid requests rather than repairing authority or evidence: %j", value => {
  expect(() => parse(value)).toThrow();
});
it("requires bounded evidence even when the model claims completion", () => {
  expect(parse({ tool: "finish", message: "Added to cart", evidence: ["Added to your cart"] })).toEqual({ kind: "finish", message: "Added to cart", evidence: ["Added to your cart"] });
  expect(() => parse({ tool: "answer", message: "Answer", evidence: Array(5).fill("Observed quote") })).toThrow();
});
