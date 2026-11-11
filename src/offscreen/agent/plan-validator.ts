/**
 * @file src/offscreen/agent/plan-validator.ts
 * @description Validates AgentPlan objects against the JSON Schema specifications.
 * Fully CSP-compliant (zero eval / no new Function) for Chrome Extension Manifest V3.
 *
 * Validation is a critical safety gate — it ensures the LLM never produces
 * malformed plans that could cause the executor to behave unexpectedly.
 */

import type { AgentPlan } from "@shared/types.js";

/** Thrown when an AgentPlan fails schema validation. */
export class ValidationError extends Error {
  /** Validation errors (human-readable) */
  readonly validationErrors: string;

  constructor(message: string, validationErrors: string) {
    super(message);
    this.name = "ValidationError";
    this.validationErrors = validationErrors;
  }
}

const VAULT_FIELD_KEYS = new Set([
  "email", "username", "password", "fullName", "firstName", "lastName", "phone",
  "address.line1", "address.line2", "address.city", "address.state", "address.zip", "address.country",
  "creditCard.number", "creditCard.expiry", "creditCard.cvv", "creditCard.name"
]);

const SCROLL_DIRECTIONS = new Set(["up", "down", "left", "right"]);
const TAB_OPERATIONS = new Set(["open", "close", "switch"]);
const HANDLE_PATTERN = /^e[0-9]+$/;

/**
 * PlanValidator validates plans produced by the LLM or intent router
 * before they reach the executor without any dynamic code evaluation.
 */
export class PlanValidator {
  private lastErrors: string[] | null = null;

  /**
   * Validate an AgentPlan against the schema constraints.
   *
   * @param plan The plan to validate (may be unknown/untyped LLM output)
   * @throws {ValidationError} if the plan is invalid
   * @returns The plan typed as AgentPlan if valid
   */
  validate(plan: unknown): AgentPlan {
    const errors: string[] = [];

    if (typeof plan !== "object" || plan === null || Array.isArray(plan)) {
      throw new ValidationError("AgentPlan must be an object", "root: must be an object");
    }

    const p = plan as any;

    // Allowed keys on root
    const allowedRootKeys = new Set(["intent", "actions", "risk", "requiresConfirmation"]);
    for (const key of Object.keys(p)) {
      if (!allowedRootKeys.has(key)) {
        errors.push(`root: unexpected property '${key}'`);
      }
    }

    // intent
    if (typeof p.intent !== "string" || p.intent.length < 1 || p.intent.length > 300) {
      errors.push("intent: must be a string between 1 and 300 characters");
    }

    // risk
    if (typeof p.risk !== "number" || !Number.isInteger(p.risk) || p.risk < 0 || p.risk > 4) {
      errors.push("risk: must be an integer between 0 and 4");
    }

    // requiresConfirmation
    if (typeof p.requiresConfirmation !== "boolean") {
      errors.push("requiresConfirmation: must be a boolean");
    }

    // actions
    if (!Array.isArray(p.actions) || p.actions.length < 1 || p.actions.length > 20) {
      errors.push("actions: must be an array of 1 to 20 actions");
    } else {
      p.actions.forEach((action: unknown, idx: number) => {
        this.validateAction(action, idx, errors);
      });
    }

    if (errors.length > 0) {
      this.lastErrors = errors;
      const formatted = errors.map((e) => `  - ${e}`).join("\n");
      throw new ValidationError(`AgentPlan validation failed:\n${formatted}`, formatted);
    }

    this.lastErrors = null;
    return plan as AgentPlan;
  }

  /**
   * Check if a plan is valid without throwing.
   * @returns true if valid, false otherwise
   */
  isValid(plan: unknown): plan is AgentPlan {
    try {
      this.validate(plan);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get human-readable validation errors for the last failed validation.
   * Returns null if the last validation succeeded.
   */
  getLastErrors(): string | null {
    if (!this.lastErrors || this.lastErrors.length === 0) return null;
    return this.lastErrors.join("\n");
  }

  private validateAction(action: unknown, idx: number, errors: string[]): void {
    if (typeof action !== "object" || action === null || Array.isArray(action)) {
      errors.push(`actions[${idx}]: must be an object`);
      return;
    }

    const a = action as any;
    const type = a.type;

    if (typeof type !== "string") {
      errors.push(`actions[${idx}].type: must be a string`);
      return;
    }

    switch (type) {
      case "click": {
        const allowed = new Set(["type", "handle", "label"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10) {
          errors.push(`actions[${idx}].handle: must match format e[0-9]+`);
        }
        if (a.label !== undefined && (typeof a.label !== "string" || a.label.length > 200)) {
          errors.push(`actions[${idx}].label: must be a string up to 200 chars`);
        }
        break;
      }

      case "type": {
        const allowed = new Set(["type", "handle", "text", "clear"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10) {
          errors.push(`actions[${idx}].handle: must match format e[0-9]+`);
        }
        if (typeof a.text !== "string" || a.text.length > 2000) {
          errors.push(`actions[${idx}].text: must be a string up to 2000 chars`);
        }
        if (a.clear !== undefined && typeof a.clear !== "boolean") {
          errors.push(`actions[${idx}].clear: must be boolean`);
        }
        break;
      }

      case "select": {
        const allowed = new Set(["type", "handle", "option"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10) {
          errors.push(`actions[${idx}].handle: must match format e[0-9]+`);
        }
        if (typeof a.option !== "string" || a.option.length > 500) {
          errors.push(`actions[${idx}].option: must be a string up to 500 chars`);
        }
        break;
      }

      case "toggle": {
        const allowed = new Set(["type", "handle", "checked"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10) {
          errors.push(`actions[${idx}].handle: must match format e[0-9]+`);
        }
        if (typeof a.checked !== "boolean") {
          errors.push(`actions[${idx}].checked: must be boolean`);
        }
        break;
      }

      case "scroll": {
        const allowed = new Set(["type", "direction", "handle", "amount"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.direction !== "string" || !SCROLL_DIRECTIONS.has(a.direction)) {
          errors.push(`actions[${idx}].direction: must be one of up, down, left, right`);
        }
        if (a.handle !== undefined && a.handle !== null && (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10)) {
          errors.push(`actions[${idx}].handle: must be null or format e[0-9]+`);
        }
        if (a.amount !== undefined && (typeof a.amount !== "number" || !Number.isInteger(a.amount) || a.amount < 1 || a.amount > 10000)) {
          errors.push(`actions[${idx}].amount: must be integer between 1 and 10000`);
        }
        break;
      }

      case "navigate": {
        const allowed = new Set(["type", "url"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.url !== "string" || a.url.length > 2048 || !/^https?:\/\//i.test(a.url)) {
          errors.push(`actions[${idx}].url: must be a valid http(s) URL up to 2048 chars`);
        }
        break;
      }

      case "tab": {
        const allowed = new Set(["type", "operation", "url", "index"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.operation !== "string" || !TAB_OPERATIONS.has(a.operation)) {
          errors.push(`actions[${idx}].operation: must be open, close, or switch`);
        }
        if (a.url !== undefined && (typeof a.url !== "string" || a.url.length > 2048)) {
          errors.push(`actions[${idx}].url: must be a string up to 2048 chars`);
        }
        if (a.index !== undefined && (typeof a.index !== "number" || !Number.isInteger(a.index) || a.index < 0 || a.index > 999)) {
          errors.push(`actions[${idx}].index: must be integer between 0 and 999`);
        }
        break;
      }

      case "read": {
        const allowed = new Set(["type", "handle"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (a.handle !== undefined && a.handle !== null && (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10)) {
          errors.push(`actions[${idx}].handle: must be null or format e[0-9]+`);
        }
        break;
      }

      case "fill_from_vault": {
        const allowed = new Set(["type", "handle", "vaultField"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.handle !== "string" || !HANDLE_PATTERN.test(a.handle) || a.handle.length > 10) {
          errors.push(`actions[${idx}].handle: must match format e[0-9]+`);
        }
        if (typeof a.vaultField !== "string" || !VAULT_FIELD_KEYS.has(a.vaultField)) {
          errors.push(`actions[${idx}].vaultField: invalid vault field key`);
        }
        break;
      }

      case "ask": {
        const allowed = new Set(["type", "question", "options"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.question !== "string" || a.question.length < 1 || a.question.length > 500) {
          errors.push(`actions[${idx}].question: must be a string between 1 and 500 chars`);
        }
        if (a.options !== undefined) {
          if (!Array.isArray(a.options) || a.options.length > 6 || a.options.some((opt: unknown) => typeof opt !== "string" || (opt as string).length > 100)) {
            errors.push(`actions[${idx}].options: must be array of up to 6 strings (each max 100 chars)`);
          }
        }
        break;
      }

      case "done": {
        const allowed = new Set(["type", "summary"]);
        this.checkExtraKeys(a, allowed, `actions[${idx}]`, errors);
        if (typeof a.summary !== "string" || a.summary.length < 1 || a.summary.length > 500) {
          errors.push(`actions[${idx}].summary: must be a string between 1 and 500 chars`);
        }
        break;
      }

      default:
        errors.push(`actions[${idx}].type: unknown action type '${type}'`);
    }
  }

  private checkExtraKeys(obj: Record<string, unknown>, allowed: Set<string>, path: string, errors: string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.has(key)) {
        errors.push(`${path}: unexpected property '${key}'`);
      }
    }
  }
}
