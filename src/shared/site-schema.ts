import type { SchemaObject } from "ajv";
import type { SiteDecision } from "./site-task.js";
const str = (maxLength = 500) => ({ type: "string", minLength: 1, maxLength });
const handle = { type: "string", pattern: "^e[0-9]+$", maxLength: 20 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const action = (type: string, fields: Record<string, unknown>, required = Object.keys(fields)) => object({ type: { const: type, type: "string" }, ...fields }, ["type", ...required]);
export const SITE_DECISION_SCHEMA: SchemaObject = {
  anyOf: [
    object({ kind: { const: "act", type: "string" }, action: { anyOf: [
      action("click", { handle }), action("type", { handle, text: str(2000), clear: { type: "boolean" } }, ["handle", "text"]),
      action("select", { handle, option: str(200) }), action("toggle", { handle, checked: { type: "boolean" } }),
      action("submit", { handle }), action("navigate", { url: str(2048) }),
      action("scroll", { handle: { anyOf: [handle, { type: "null" }] }, direction: { enum: ["up", "down", "left", "right"], type: "string" }, amount: { type: "integer", minimum: 1, maximum: 2000 } }, ["handle", "direction"]),
      action("read", { handle: { anyOf: [handle, { type: "null" }] } }),
    ] }, expected: { anyOf: [object({ kind: { const: "control_state", type: "string" } }), object({ kind: { const: "page_changed", type: "string" } }), object({ kind: { const: "text_appeared", type: "string" }, text: str(200) })] } }),
    object({ kind: { const: "observe", type: "string" }, reason: str(200) }),
    object({ kind: { const: "ask", type: "string" }, question: str() }),
    object({ kind: { enum: ["finish", "answer"], type: "string" }, message: str(), evidence: { type: "array", minItems: 1, maxItems: 4, items: str(200) } }),
    object({ kind: { const: "unavailable", type: "string" }, reason: { type: "string", enum: ["not_found_in_scope", "blocked_by_site_state", "unsupported_by_extension", "blocked_by_policy"] }, message: str() }),
  ],
};
/** Validate our packaged schema subset without eval/new Function (MV3 CSP). */
function matches(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const rule = schema as Record<string, unknown>;
  if (Array.isArray(rule["anyOf"])) return rule["anyOf"].some(item => matches(item, value));
  if ("const" in rule && value !== rule["const"]) return false;
  if (Array.isArray(rule["enum"]) && !rule["enum"].includes(value)) return false;
  switch (rule["type"]) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "integer": return typeof value === "number" && Number.isInteger(value) && value >= Number(rule["minimum"] ?? -Infinity) && value <= Number(rule["maximum"] ?? Infinity);
    case "string": return typeof value === "string" && value.length >= Number(rule["minLength"] ?? 0) && value.length <= Number(rule["maxLength"] ?? Infinity) && (typeof rule["pattern"] !== "string" || new RegExp(rule["pattern"]).test(value));
    case "array": return Array.isArray(value) && value.length >= Number(rule["minItems"] ?? 0) && value.length <= Number(rule["maxItems"] ?? Infinity) && value.every(item => matches(rule["items"], item));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const fields = rule["properties"] as Record<string, unknown>;
      const input = value as Record<string, unknown>;
      if (Object.keys(input).some(key => !Object.hasOwn(fields, key))) return false;
      if (Array.isArray(rule["required"]) && rule["required"].some(key => typeof key !== "string" || !Object.hasOwn(input, key))) return false;
      return Object.entries(input).every(([key, item]) => matches(fields[key], item));
    }
    default: return false;
  }
}
export function parseSiteDecision(raw: string): SiteDecision {
  if (raw.length > 16_000) throw new Error("The next-step response is too large.");
  const value: unknown = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
  if (!matches(SITE_DECISION_SCHEMA, value)) throw new Error("The planner returned an invalid next-step decision.");
  return value as SiteDecision;
}
function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "pattern"].includes(key)).map(([key, item]) => [key, compact(item)]));
}
export const SITE_GENERATION_SCHEMA = compact(SITE_DECISION_SCHEMA);
