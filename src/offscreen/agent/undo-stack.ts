/**
 * @file src/offscreen/agent/undo-stack.ts
 * @description Undo stack for reversible agent actions (SRS FR-SAFE-03).
 *
 * Tracks the last N reversible actions so the user can say "Undo" to revert.
 * Only R0–R2 actions (read-only, single-field, multi-field) are undoable.
 * R3/R4 actions (submissions, payments) are not undoable.
 */

import type { AgentAction, AgentPlan } from "@shared/types.js";
import { RiskTier } from "@shared/types.js";

/** Maximum number of undo entries to keep in memory. */
const MAX_UNDO_ENTRIES = 10;

/** An entry in the undo stack. */
export interface UndoEntry {
  /** The plan that was executed. */
  plan: AgentPlan;
  /** Timestamp of execution (ms since epoch). */
  executedAt: number;
  /** Tab ID where the plan was executed. */
  tabId: number;
  /** Whether this entry has already been undone. */
  undone: boolean;
}

/**
 * UndoStack maintains a bounded list of recently executed plans.
 * Only plans with risk tier ≤ R2 are stored (undoable actions).
 */
export class UndoStack {
  private readonly entries: UndoEntry[] = [];

  /**
   * Push a newly executed plan onto the undo stack.
   * Plans with risk tier R3 or R4 are silently ignored (not undoable).
   *
   * @param plan - The executed AgentPlan.
   * @param tabId - The tab where the plan ran.
   */
  push(plan: AgentPlan, tabId: number): void {
    if (plan.risk >= RiskTier.R3) {
      // High-risk actions are intentional and irreversible by policy
      return;
    }

    this.entries.unshift({
      plan,
      executedAt: Date.now(),
      tabId,
      undone: false,
    });

    // Trim to max size
    if (this.entries.length > MAX_UNDO_ENTRIES) {
      this.entries.splice(MAX_UNDO_ENTRIES);
    }
  }

  /**
   * Peek at the most recent undoable entry without removing it.
   * @returns The top entry, or null if stack is empty or top is already undone.
   */
  peek(): UndoEntry | null {
    for (const entry of this.entries) {
      if (!entry.undone) return entry;
    }
    return null;
  }

  /**
   * Mark the most recent entry as undone and return it.
   * The caller is responsible for dispatching the actual DOM undo action.
   *
   * @returns The entry that was undone, or null if nothing to undo.
   */
  undo(): UndoEntry | null {
    for (const entry of this.entries) {
      if (!entry.undone) {
        entry.undone = true;
        return entry;
      }
    }
    return null;
  }

  /**
   * Build the inverse action list for a given plan.
   * For simple type actions: clear the field.
   * For click actions: no reliable inverse (return empty).
   *
   * @param entry - The undo entry to invert.
   * @returns Array of AgentActions that approximate reversal.
   */
  buildInverseActions(entry: UndoEntry): AgentAction[] {
    const inverse: AgentAction[] = [];

    for (const action of entry.plan.actions) {
      switch (action.type) {
        case "type":
          // Restore empty field — best-effort undo
          inverse.push({ type: "type", handle: action.handle, text: "", clear: true });
          break;
        case "select":
          // Cannot easily restore previous selection without snapshot diff
          // TODO: capture pre-action snapshot for accurate undo
          break;
        case "toggle":
          // Invert the toggle state
          inverse.push({ type: "toggle", handle: action.handle, checked: !action.checked });
          break;
        case "scroll": {
          // Invert scroll direction
          const scrollAction: Parameters<typeof inverse.push>[0] = {
            type: "scroll",
            handle: action.handle,
            direction: action.direction === "down" ? "up"
              : action.direction === "up" ? "down"
              : action.direction === "right" ? "left"
              : "right",
          };
          if (action.amount !== undefined) {
            (scrollAction as { amount?: number }).amount = action.amount;
          }
          inverse.push(scrollAction);
          break;
        }
        // click, navigate, tab, read, fill_from_vault, ask, done — no reliable inverse
        default:
          break;
      }
    }

    return inverse;
  }

  /** Return all entries (for display in side panel history). */
  getAll(): UndoEntry[] {
    return [...this.entries];
  }

  /** Clear all entries (e.g., on session end or tab close). */
  clear(): void {
    this.entries.length = 0;
  }

  /** Number of entries currently in the stack. */
  get size(): number {
    return this.entries.length;
  }
}

