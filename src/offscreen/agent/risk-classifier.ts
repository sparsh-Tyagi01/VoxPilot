/**
 * @file src/offscreen/agent/risk-classifier.ts
 * @description Risk classifier for AgentPlan actions.
 *
 * The risk classifier assigns a RiskTier (R0–R4) to an AgentPlan based on
 * the types of actions it contains. It may escalate the tier assigned by
 * the LLM (but never de-escalates).
 *
 * Risk tier definitions:
 *
 * | Tier | Actions                                              | Confirm? |
 * |------|------------------------------------------------------|----------|
 * | R0   | read, scroll                                         | No       |
 * | R1   | type (single field), click (non-submit), select      | No       |
 * | R2   | Multiple typed fields, navigate, tab open/close      | No       |
 * | R3   | Form submit click, file operation, fill_from_vault   | Yes      |
 * | R4   | Actions on payment/deletion pages, irreversible ops  | Yes      |
 *
 * The classifier is intentionally conservative — when in doubt, it assigns
 * a higher tier. False positives (over-requesting confirmation) are always
 * preferred over false negatives.
 */

import { RiskTier } from "@shared/types.js";
import type { AgentPlan, AgentAction } from "@shared/types.js";

/** URL patterns that indicate high-risk pages (R4). */
const HIGH_RISK_URL_PATTERNS = [
  /checkout/i,
  /payment/i,
  /purchase/i,
  /billing/i,
  /delete/i,
  /remove/i,
  /cancel.*account/i,
  /unsubscribe/i,
  /transfer/i,
  /send.*money/i,
];

/** Submit button text patterns that indicate R3 risk. */
const SUBMIT_BUTTON_PATTERNS = [
  /^submit$/i,
  /^send$/i,
  /^confirm$/i,
  /^pay$/i,
  /^buy\s+now$/i,
  /^place\s+order$/i,
  /^checkout$/i,
  /^sign\s+up$/i,
  /^register$/i,
  /^create\s+account$/i,
  /^delete$/i,
  /^remove$/i,
  /^unsubscribe$/i,
];

/**
 * RiskClassifier analyzes an AgentPlan and assigns the appropriate RiskTier.
 * The result may be higher than the LLM's self-reported risk, but never lower.
 */
export class RiskClassifier {
  /**
   * Classify an AgentPlan and return the appropriate RiskTier.
   * This may escalate `plan.risk` but never de-escalates it.
   *
   * @param plan The plan to classify
   * @param currentUrl Optional current page URL for URL-based heuristics
   * @returns The determined RiskTier
   */
  classify(plan: AgentPlan, currentUrl?: string): RiskTier {
    let tier = RiskTier.R0;

    // Start from the LLM's self-reported risk (never go lower)
    tier = Math.max(tier, plan.risk) as RiskTier;

    // Analyze each action
    let typeActionCount = 0;
    let hasVaultFill = false;
    // let hasNavigation = false; // reserved for future use

    for (const action of plan.actions) {
      const actionTier = this.classifyAction(action);
      tier = Math.max(tier, actionTier) as RiskTier;

      if (action.type === "type") typeActionCount++;
      if (action.type === "fill_from_vault") hasVaultFill = true;
      // hasNavigation tracking reserved for future use
    }

    // Escalate R1 to R2 if multiple type actions (multi-field form)
    if (typeActionCount > 1 && tier < RiskTier.R2) {
      tier = RiskTier.R2;
    }

    // Vault fill on a form is at least R3
    if (hasVaultFill && tier < RiskTier.R3) {
      tier = RiskTier.R3;
    }

    // URL-based escalation to R4
    if (currentUrl) {
      for (const pattern of HIGH_RISK_URL_PATTERNS) {
        if (pattern.test(currentUrl) && tier < RiskTier.R4) {
          tier = RiskTier.R4;
          break;
        }
      }
    }

    return tier;
  }

  /**
   * Classify a single action to its minimum risk tier.
   */
  private classifyAction(action: AgentAction): RiskTier {
    switch (action.type) {
      // ── R0: Read-only ────────────────────────────────────────────────────
      case "read":
        return RiskTier.R0;

      case "scroll":
        return RiskTier.R0;

      case "done":
        return RiskTier.R0;

      // ── R1: Reversible single actions ────────────────────────────────────
      case "type":
        return RiskTier.R1;

      case "select":
        return RiskTier.R1;

      case "toggle":
        return RiskTier.R1;

      case "ask":
        return RiskTier.R0; // Asking is read-only from the page's perspective

      // ── R2: Navigation and tab management ────────────────────────────────
      case "navigate": {
        const url = action.url.toLowerCase();
        // Check for high-risk URL patterns
        for (const pattern of HIGH_RISK_URL_PATTERNS) {
          if (pattern.test(url)) return RiskTier.R4;
        }
        return RiskTier.R2;
      }

      case "tab":
        return action.operation === "close" ? RiskTier.R2 : RiskTier.R1;

      // ── R3: Potentially destructive ──────────────────────────────────────
      case "click": {
        // Check if the click target label looks like a submit button
        if (action.label) {
          for (const pattern of SUBMIT_BUTTON_PATTERNS) {
            if (pattern.test(action.label)) return RiskTier.R3;
          }
        }
        return RiskTier.R1;
      }

      // ── R3: Vault fill (sensitive data involved) ──────────────────────────
      case "fill_from_vault":
        return RiskTier.R3;

      // Unknown action type — escalate to be safe
      default: {
        const exhaustiveCheck: never = action;
        console.warn("[RiskClassifier] Unknown action type:", exhaustiveCheck);
        return RiskTier.R4;
      }
    }
  }

  /**
   * Check if a URL is considered high-risk.
   * @returns true if the URL matches a high-risk pattern
   */
  isHighRiskUrl(url: string): boolean {
    return HIGH_RISK_URL_PATTERNS.some((pattern) => pattern.test(url));
  }
}
