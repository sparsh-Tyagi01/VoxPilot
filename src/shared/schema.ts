/**
 * @file src/shared/schema.ts
 * @description JSON Schema for AgentPlan — the structured LLM output format.
 * Based on SRS v2.0 Appendix A.
 *
 * This schema is:
 * 1. Sent to the LLM worker as a constrained-decoding grammar (WebLLM grammar mode).
 * 2. Used by plan-validator.ts (AJV) to validate LLM output before execution.
 *
 * The schema enforces:
 * - Required fields on every action type
 * - Enum constraints on direction, risk tier, operation types
 * - String length limits to prevent prompt injection via oversized strings
 * - Additional properties disallowed at every level
 */

import { BROWSER_NAVIGATION_COMMANDS } from "./constants.js";
import type { SchemaObject } from "ajv";

// ─── Individual Action Schemas ────────────────────────────────────────────────

const clickActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "click" },
    handle: { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
    label: { type: "string", maxLength: 200 },
  },
  required: ["type", "handle"],
  additionalProperties: false,
};

const typeActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "type" },
    handle: { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
    text: { type: "string", maxLength: 2000 },
    clear: { type: "boolean" },
  },
  required: ["type", "handle", "text"],
  additionalProperties: false,
};

const selectActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "select" },
    handle: { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
    option: { type: "string", maxLength: 500 },
  },
  required: ["type", "handle", "option"],
  additionalProperties: false,
};

const toggleActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "toggle" },
    handle: { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
    checked: { type: "boolean" },
  },
  required: ["type", "handle", "checked"],
  additionalProperties: false,
};

const scrollActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "scroll" },
    handle: {
      oneOf: [
        { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
        { type: "null" },
      ],
    },
    direction: { type: "string", enum: ["up", "down", "left", "right"] },
    amount: { type: "integer", minimum: 1, maximum: 100000 },
  },
  required: ["type", "direction"],
  additionalProperties: false,
};

const navigateActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "navigate" },
    url: {
      type: "string",
      maxLength: 2048,
      anyOf: [{ pattern: "^https?://" }, { enum: [...BROWSER_NAVIGATION_COMMANDS] }],
    },
  },
  required: ["type", "url"],
  additionalProperties: false,
};

const tabActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "tab" },
    operation: { type: "string", enum: ["open", "close", "switch"] },
    url: { type: "string", maxLength: 2048, anyOf: [{ pattern: "^https?://" }, { const: "chrome://newtab" }] },
    index: { type: "integer", minimum: -1, maximum: 999 },
  },
  required: ["type", "operation"],
  additionalProperties: false,
};

const readActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "read" },
    handle: {
      oneOf: [
        { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
        { type: "null" },
      ],
    },
  },
  required: ["type"],
  additionalProperties: false,
};

/** Allowed vault field keys — must stay in sync with VaultFieldKey in types.ts */
const VAULT_FIELD_KEYS = [
  "email",
  "username",
  "password",
  "fullName",
  "firstName",
  "lastName",
  "phone",
  "address.line1",
  "address.line2",
  "address.city",
  "address.state",
  "address.zip",
  "address.country",
  "creditCard.number",
  "creditCard.expiry",
  "creditCard.cvv",
  "creditCard.name",
] as const;

const fillFromVaultActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "fill_from_vault" },
    handle: { type: "string", pattern: "^e[0-9]+$", maxLength: 10 },
    vaultField: { type: "string", enum: [...VAULT_FIELD_KEYS] },
  },
  required: ["type", "handle", "vaultField"],
  additionalProperties: false,
};

const askActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "ask" },
    question: { type: "string", minLength: 1, maxLength: 500 },
    options: {
      type: "array",
      items: { type: "string", maxLength: 100 },
      maxItems: 6,
    },
  },
  required: ["type", "question"],
  additionalProperties: false,
};

const doneActionSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", const: "done" },
    summary: { type: "string", minLength: 1, maxLength: 500 },
  },
  required: ["type", "summary"],
  additionalProperties: false,
};

// ─── Full AgentPlan Schema ────────────────────────────────────────────────────

/**
 * Complete JSON Schema for AgentPlan.
 *
 * Example valid plan:
 * ```json
 * {
 *   "intent": "Search for 'TypeScript tutorials' on YouTube",
 *   "risk": 1,
 *   "requiresConfirmation": false,
 *   "actions": [
 *     { "type": "click", "handle": "e12" },
 *     { "type": "type", "handle": "e12", "text": "TypeScript tutorials", "clear": true },
 *     { "type": "click", "handle": "e14", "label": "Search button" },
 *     { "type": "done", "summary": "Searched YouTube for TypeScript tutorials." }
 *   ]
 * }
 * ```
 */
export const AGENT_PLAN_SCHEMA: SchemaObject = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://voxpilot.dev/schemas/agent-plan.json",
  title: "AgentPlan",
  description:
    "Structured action plan produced by the VoxPilot LLM. Validated before execution.",
  type: "object",

  properties: {
    intent: {
      type: "string",
      description:
        "Natural language restatement of the user intent (spoken to user for confirmation).",
      minLength: 1,
      maxLength: 300,
    },

    actions: {
      type: "array",
      description: "Ordered list of actions for the executor to perform.",
      minItems: 1,
      maxItems: 20,
      items: {
        oneOf: [
          clickActionSchema,
          typeActionSchema,
          selectActionSchema,
          toggleActionSchema,
          scrollActionSchema,
          navigateActionSchema,
          tabActionSchema,
          readActionSchema,
          fillFromVaultActionSchema,
          askActionSchema,
          doneActionSchema,
        ],
      },
    },

    risk: {
      type: "integer",
      description:
        "Pre-classified risk tier (0-4). The risk classifier may escalate this.",
      minimum: 0,
      maximum: 4,
    },

    requiresConfirmation: {
      type: "boolean",
      description:
        "Whether the LLM requests explicit user confirmation before executing.",
    },
  },

  required: ["intent", "actions", "risk", "requiresConfirmation"],
  additionalProperties: false,
};

/** Schema ID used to register with AJV. */
export const AGENT_PLAN_SCHEMA_ID = AGENT_PLAN_SCHEMA["$id"] as string;

/** Keep native grammar compilation small; enforce detailed bounds locally afterward. */
function generationSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(generationSchema);
  if (!value || typeof value !== "object") return value;
  const omit = new Set(["$schema", "$id", "title", "description", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "pattern", "format"]);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !omit.has(key)).map(([key, item]) => [key === "oneOf" ? "anyOf" : key, generationSchema(item)]));
}
export const AGENT_PLAN_GENERATION_SCHEMA = generationSchema(AGENT_PLAN_SCHEMA);
