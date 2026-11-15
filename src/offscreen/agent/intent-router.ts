/**
 * @file src/offscreen/agent/intent-router.ts
 * @description Fast-path intent router for common voice commands.
 *
 * Before invoking the LLM (which requires a DOM snapshot and ~1-3 seconds),
 * the intent router tries to match the transcript against a set of regular
 * expression patterns for well-known, frequent commands.
 *
 * Fast-path commands resolve immediately without an LLM call, reducing
 * end-to-end latency for common actions to <100ms after transcription.
 *
 * If no pattern matches, `route()` returns null and the caller falls through
 * to the full LLM planning path.
 *
 * Pattern design principles:
 * - Anchored with `^` and `$` to avoid partial matches
 * - Case-insensitive (`i` flag)
 * - Capture groups named for clarity
 * - Liberal with optional words ("please", "the", etc.)
 */

import { RiskTier } from "@shared/types.js";
import type { AgentPlan } from "@shared/types.js";

/** A single intent pattern and its plan factory. */
interface IntentPattern {
  /** Human-readable name for debugging */
  name: string;
  /** Regular expression to match against the transcript */
  pattern: RegExp;
  /** Factory: given the regex match, return an AgentPlan (or null to skip) */
  planFactory: (match: RegExpMatchArray) => AgentPlan | null;
}

function normalizeTranscript(transcript: string): string {
  return transcript
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+$/g, "")
    .trim();
}

/**
 * IntentRouter tries to match a transcript against a set of fast-path patterns.
 * Returns null if no pattern matches (indicating LLM planning is needed).
 */
export class IntentRouter {
  private readonly patterns: IntentPattern[];

  constructor() {
    this.patterns = this.buildPatterns();
  }

  /**
   * Attempt to match the transcript to a fast-path intent.
   * @param transcript Normalized (trimmed) transcript text
   * @returns An AgentPlan if matched, or null to fall through to LLM
   */
  /**
   * Check if the transcript is a global kill-switch command (FR-SAFE-04).
   * Returns true for: stop, abort, cancel, quit, exit, never mind, etc.
   */
  isKillCommand(transcript: string): boolean {
    const normalised = normalizeTranscript(transcript);
    return /^(?:stop|abort|cancel|quit|exit|never\s*mind|stop\s+that|stop\s+it)$/.test(normalised);
  }

  /**
   * Check if the transcript is an undo command (FR-SAFE-03).
   * Returns true for: undo, undo that, undo last action, revert, etc.
   */
  isUndoCommand(transcript: string): boolean {
    const normalised = normalizeTranscript(transcript);
    return /^(?:please\s+)?(?:undo|undo\s+that|undo\s+last\s+action|revert|revert\s+that)$/.test(normalised);
  }

  route(transcript: string): AgentPlan | null {
    const normalized = normalizeTranscript(transcript);

    for (const { name, pattern, planFactory } of this.patterns) {
      const match = normalized.match(pattern);
      if (match) {
        const plan = planFactory(match);
        if (plan) {
          console.log(`[IntentRouter] Fast-path match: "${name}"`);
          return plan;
        }
      }
    }

    console.log("[IntentRouter] No fast-path match — falling through to LLM.");
    return null;
  }

  /**
   * Build all fast-path intent patterns.
   * Add new patterns here as new common commands are identified.
   */
  private buildPatterns(): IntentPattern[] {
    return [
      // ── Scroll ─────────────────────────────────────────────────────────────
      {
        name: "scroll-up",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:scroll\s+up|go\s+up|page\s+up)(?:\s+a\s+(?:bit|little))?(?:\s+please)?$/i,
        planFactory: () => ({
          intent: "Scroll up the page",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "scroll", handle: null, direction: "up", amount: 750 },
            { type: "done", summary: "Scrolled up." },
          ],
        }),
      },
      {
        name: "scroll-down",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:scroll\s+down|go\s+down|page\s+down)(?:\s+a\s+(?:bit|little))?(?:\s+please)?$/i,
        planFactory: () => ({
          intent: "Scroll down the page",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "scroll", handle: null, direction: "down", amount: 750 },
            { type: "done", summary: "Scrolled down." },
          ],
        }),
      },
      {
        name: "scroll-default",
        pattern: /^(?:can\s+you\s+|please\s+)?scroll(?:\s+a\s+(?:bit|little))?(?:\s+please)?$/i,
        planFactory: () => ({
          intent: "Scroll down the page",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "scroll", handle: null, direction: "down", amount: 750 },
            { type: "done", summary: "Scrolled down." },
          ],
        }),
      },
      {
        name: "scroll-to-top",
        pattern: /^(?:go\s+to\s+|scroll\s+to\s+)?(?:the\s+)?top(?:\s+of\s+(?:the\s+)?page)?$/i,
        planFactory: () => ({
          intent: "Scroll to the top of the page",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "scroll", handle: null, direction: "up", amount: 99999 },
            { type: "done", summary: "Scrolled to top." },
          ],
        }),
      },
      {
        name: "scroll-to-bottom",
        pattern: /^(?:go\s+to\s+|scroll\s+to\s+)?(?:the\s+)?bottom(?:\s+of\s+(?:the\s+)?page)?$/i,
        planFactory: () => ({
          intent: "Scroll to the bottom of the page",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "scroll", handle: null, direction: "down", amount: 99999 },
            { type: "done", summary: "Scrolled to bottom." },
          ],
        }),
      },

      // ── Navigation ─────────────────────────────────────────────────────────
      {
        name: "go-back",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:go\s+back|back(?:\s+a\s+page)?|previous\s+page)$/i,
        planFactory: () => ({
          intent: "Navigate back",
          risk: RiskTier.R1,
          requiresConfirmation: false,
          actions: [
            { type: "navigate", url: "javascript:history.back()" },
            { type: "done", summary: "Navigated back." },
          ],
        }),
      },
      {
        name: "go-forward",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:go\s+forward|forward(?:\s+a\s+page)?|next\s+page)$/i,
        planFactory: () => ({
          intent: "Navigate forward",
          risk: RiskTier.R1,
          requiresConfirmation: false,
          actions: [
            { type: "navigate", url: "javascript:history.forward()" },
            { type: "done", summary: "Navigated forward." },
          ],
        }),
      },
      {
        name: "reload-page",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:reload|refresh)(?:\s+(?:the\s+)?page)?$/i,
        planFactory: () => ({
          intent: "Reload the page",
          risk: RiskTier.R1,
          requiresConfirmation: false,
          actions: [
            { type: "navigate", url: "javascript:location.reload()" },
            { type: "done", summary: "Page reloaded." },
          ],
        }),
      },

      // ── Click / Select ─────────────────────────────────────────────────────
      {
        name: "click-element",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:click|tap|press|select)(?:\s+on)?(?:\s+the)?\s+(.+)$/i,
        planFactory: (match) => {
          const target = match[1]?.trim();
          if (!target || target.length < 2) return null;
          return {
            intent: `Click "${target}"`,
            risk: RiskTier.R1,
            requiresConfirmation: false,
            actions: [
              { type: "click", handle: target },
              { type: "done", summary: `Clicked "${target}".` },
            ],
          };
        },
      },

      // Search is handled by the site task loop, including explicit submission and verification.

      // ── Type Text ──────────────────────────────────────────────────────────
      {
        name: "type-text",
        pattern: /^(?:can\s+you\s+|please\s+)?(?:type|write|input|enter)\s+(.+?)(?:\s+(?:in|into|on)\s+(.+))?$/i,
        planFactory: (match) => {
          const text = match[1]?.trim();
          const field = match[2]?.trim() || "input";
          if (!text) return null;
          return {
            intent: `Type "${text}" into ${field}`,
            risk: RiskTier.R1,
            requiresConfirmation: false,
            actions: [
              { type: "type", handle: field, text },
              { type: "done", summary: `Typed "${text}".` },
            ],
          };
        },
      },

      // ── Tab Management ─────────────────────────────────────────────────────
      {
        name: "new-tab",
        pattern: /^(?:open\s+(?:a\s+)?)?new\s+tab$/i,
        planFactory: () => ({
          intent: "Open a new tab",
          risk: RiskTier.R1,
          requiresConfirmation: false,
          actions: [
            { type: "tab", operation: "open", url: "chrome://newtab" },
            { type: "done", summary: "Opened a new tab." },
          ],
        }),
      },
      {
        name: "close-tab",
        pattern: /^close\s+(?:this\s+)?tab$/i,
        planFactory: () => ({
          intent: "Close the current tab",
          risk: RiskTier.R2,
          requiresConfirmation: false,
          actions: [
            { type: "tab", operation: "close" },
            { type: "done", summary: "Tab closed." },
          ],
        }),
      },
      {
        name: "next-tab",
        pattern: /^(?:switch\s+to\s+)?(?:the\s+)?next\s+tab$/i,
        planFactory: () => ({
          intent: "Switch to next tab",
          risk: RiskTier.R1,
          requiresConfirmation: false,
          actions: [
            { type: "tab", operation: "switch", index: 1 },
            { type: "done", summary: "Switched to next tab." },
          ],
        }),
      },
      {
        name: "prev-tab",
        pattern: /^(?:switch\s+to\s+)?(?:the\s+)?(?:previous|prev)\s+tab$/i,
        planFactory: () => ({
          intent: "Switch to previous tab",
          risk: RiskTier.R1,
          requiresConfirmation: false,
          actions: [
            { type: "tab", operation: "switch", index: -1 },
            { type: "done", summary: "Switched to previous tab." },
          ],
        }),
      },

      // ── Read Page ──────────────────────────────────────────────────────────
      {
        name: "read-page",
        pattern: /^read\s+(?:the\s+)?(?:page|article|content)$/i,
        planFactory: () => ({
          intent: "Read the page content aloud",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "read", handle: null },
            { type: "done", summary: "Read the page." },
          ],
        }),
      },

      // ── Go to URL ──────────────────────────────────────────────────────────
      {
        name: "go-to-url",
        pattern: /^(?:go\s+to\s+|navigate\s+to\s+|open\s+)(?:https?:\/\/)?(.+)$/i,
        planFactory: (match) => {
          const rawUrl = match[1]?.trim() ?? "";
          if (!rawUrl) return null;
          // Basic URL construction
          const url = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
          // Validate looks like a domain
          if (!url.includes(".")) return null;
          return {
            intent: `Navigate to ${url}`,
            risk: RiskTier.R1,
            requiresConfirmation: false,
            actions: [
              { type: "navigate", url },
              { type: "done", summary: `Navigated to ${url}.` },
            ],
          };
        },
      },

      // ── Stop / Cancel ──────────────────────────────────────────────────────
      {
        name: "stop-listening",
        pattern: /^(?:stop|cancel|quit|exit|never\s+mind)$/i,
        planFactory: () => ({
          intent: "Stop listening",
          risk: RiskTier.R0,
          requiresConfirmation: false,
          actions: [
            { type: "done", summary: "Okay, stopping." },
          ],
        }),
      },
    ];
  }
}
