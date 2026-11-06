/**
 * @file src/offscreen/agent/plan-validator.ts
 * @description Validates AgentPlan objects against the JSON Schema using AJV.
 *
 * Validation is a critical safety gate — it ensures the LLM never produces
 * malformed plans that could cause the executor to behave unexpectedly.
 *
 * AJV (Another JSON Validator) is used for fast, standards-compliant JSON
 * Schema Draft-07 validation. It is configured in strict mode to catch
 * schema authoring errors as well as data errors.
 *
 * @example
 * ```ts
 * const validator = new PlanValidator();
 * validator.validate(plan); // throws ValidationError on invalid plans
 * ```
 */

import Ajv, { type ValidateFunction } from "ajv";
// import addFormats from "ajv-formats"; // TODO: add ajv-formats to devDependencies
import { AGENT_PLAN_SCHEMA } from "@shared/schema.js";
import type { AgentPlan } from "@shared/types.js";

/** Thrown when an AgentPlan fails schema validation. */
export class ValidationError extends Error {
  /** AJV validation errors (human-readable) */
  readonly validationErrors: string;

  constructor(message: string, validationErrors: string) {
    super(message);
    this.name = "ValidationError";
    this.validationErrors = validationErrors;
  }
}

/**
 * PlanValidator compiles the AgentPlan JSON Schema with AJV and validates
 * plans produced by the LLM or intent router before they reach the executor.
 */
export class PlanValidator {
  private readonly validateFn: ValidateFunction<AgentPlan>;

  constructor() {
    // Initialize AJV in strict mode
    const ajv = new Ajv({
      strict: true,
      allErrors: true,         // Collect all errors, not just the first
      coerceTypes: false,      // Never coerce types (e.g., string "1" → number 1)
      useDefaults: false,      // Don't fill in defaults (we want explicit values)
    });

    // Add format validators (e.g., "uri" format for navigate action URLs)
    // Note: ajv-formats may need to be added as a dependency
    // addFormats(ajv);  // TODO: Add ajv-formats to package.json

    // Compile the schema once at construction time (compilation is expensive)
    this.validateFn = ajv.compile<AgentPlan>(AGENT_PLAN_SCHEMA);
  }

  /**
   * Validate an AgentPlan against the JSON Schema.
   *
   * @param plan The plan to validate (may be unknown/untyped LLM output)
   * @throws {ValidationError} if the plan is invalid
   * @returns The plan typed as AgentPlan if valid
   */
  validate(plan: unknown): AgentPlan {
    const isValid = this.validateFn(plan);

    if (!isValid) {
      const errors = this.validateFn.errors ?? [];
      const errorMessages = errors
        .map((e) => `  - ${e.instancePath || "root"}: ${e.message ?? "unknown error"}`)
        .join("\n");

      throw new ValidationError(
        `AgentPlan validation failed:\n${errorMessages}`,
        errorMessages
      );
    }

    return plan as AgentPlan;
  }

  /**
   * Check if a plan is valid without throwing.
   * @returns true if valid, false otherwise
   */
  isValid(plan: unknown): plan is AgentPlan {
    return this.validateFn(plan);
  }

  /**
   * Get human-readable validation errors for the last failed validation.
   * Returns null if the last validation succeeded.
   */
  getLastErrors(): string | null {
    const errors = this.validateFn.errors;
    if (!errors || errors.length === 0) return null;

    return errors
      .map((e) => `${e.instancePath || "root"}: ${e.message ?? "unknown error"}`)
      .join("; ");
  }
}
