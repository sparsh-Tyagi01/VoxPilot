import type { SiteDecision } from "./site-task.js";
/** Small-model wire format. Conversion never grants authority or invents a target. */
export function parseCpuDecision(raw: string): SiteDecision {
  if (raw.length > 16_000) throw new Error("The CPU tool request is too large.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The CPU planner returned an invalid tool request.");
  const item = value as Record<string, unknown>;
  const tool = item["tool"];
  const string = (key: string, max = 500): string => {
    const text = item[key];
    if (typeof text !== "string" || !text.trim() || text.length > max) throw new Error("The CPU planner omitted a required tool argument.");
    return text;
  };
  const keys = (allowed: string[]) => { if (Object.keys(item).some(key => !allowed.includes(key))) throw new Error("The CPU planner returned unexpected tool arguments."); };
  const target = () => { const handle = string("target", 20); if (!/^e\d+$/.test(handle)) throw new Error("The CPU planner returned an invalid target."); return handle; };
  switch (tool) {
    case "type": keys(["tool", "target", "value"]); return { kind: "act", action: { type: "type", handle: target(), text: string("value", 2000), clear: true }, expected: { kind: "control_state" } };
    case "click": case "submit": keys(["tool", "target"]); return { kind: "act", action: { type: tool, handle: target() }, expected: { kind: "page_changed" } };
    case "select": keys(["tool", "target", "value"]); return { kind: "act", action: { type: "select", handle: target(), option: string("value", 200) }, expected: { kind: "control_state" } };
    case "toggle":
      keys(["tool", "target", "checked"]);
      if (typeof item["checked"] !== "boolean") throw new Error("The CPU planner must specify a boolean checked state.");
      return { kind: "act", action: { type: "toggle", handle: target(), checked: item["checked"] }, expected: { kind: "control_state" } };
    case "navigate": keys(["tool", "url"]); return { kind: "act", action: { type: "navigate", url: string("url", 2048) }, expected: { kind: "page_changed" } };
    case "scroll": {
      keys(["tool", "direction"]); const direction = string("direction");
      if (direction !== "up" && direction !== "down" && direction !== "left" && direction !== "right") throw new Error("The CPU planner returned an invalid scroll direction.");
      return { kind: "act", action: { type: "scroll", direction, handle: null, amount: 600 }, expected: { kind: "control_state" } };
    }
    case "ask": keys(["tool", "message"]); return { kind: "ask", question: string("message") };
    case "unavailable": keys(["tool", "message"]); return { kind: "unavailable", reason: "not_found_in_scope", message: string("message") };
    case "observe": keys(["tool", "message"]); return { kind: "observe", reason: string("message", 200) };
    case "answer": case "finish": {
      keys(["tool", "message", "evidence"]);
      const evidence = item["evidence"];
      if (!Array.isArray(evidence) || evidence.length < 1 || evidence.length > 4 || evidence.some(quote => typeof quote !== "string" || quote.length < 8 || quote.length > 200)) throw new Error("The CPU planner did not supply valid outcome evidence.");
      return { kind: tool, message: string("message"), evidence: evidence as string[] };
    }
    default: throw new Error("The CPU planner chose an unsupported tool.");
  }
}
