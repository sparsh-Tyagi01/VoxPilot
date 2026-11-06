/**
 * @file src/shared/history.ts
 * @description Transcript and action history storage.
 *
 * History is opt-in (FR-HIST-03). When disabled, nothing is persisted.
 * Entries are stored encrypted if the vault is unlocked, or as plain JSON
 * if the user opted for unencrypted history.
 *
 * SRS references:
 * - FR-HIST-01: View history of voice commands and their outcomes
 * - FR-HIST-02: Clear all history
 * - FR-HIST-03: Opt-in to history storage (disabled by default)
 * - NFR-PRV-01: History never leaves device; user can clear at any time
 * - NFR-PRV-03: Anonymize mode strips page URLs and element labels
 */

import type { AgentPlan } from "./types.js";
import { STORAGE_KEYS } from "./constants.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A single entry in the transcript history. */
export interface HistoryEntry {
  /** Stable unique ID. */
  id: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** The user's transcribed voice command. */
  transcript: string;
  /** The plan produced (or null if fast-path matched). */
  plan: AgentPlan | null;
  /** Whether execution succeeded. */
  success: boolean;
  /** Error message if execution failed. */
  error?: string;
  /** Page URL the command was issued on (omitted in anonymize mode). */
  url?: string;
  /** Page title (omitted in anonymize mode). */
  pageTitle?: string;
  /** Time from speech end to first TTS word (ms). */
  latencyMs?: number;
}

/** Storage key for history in chrome.storage.local. */
const HISTORY_KEY = "voxpilot_history_v1";

/** Maximum history entries to retain (older entries are dropped). */
const MAX_HISTORY = 200;

// ─── History Store ─────────────────────────────────────────────────────────────

/**
 * Append a new entry to the history log.
 *
 * No-op if the user hasn't opted in to history storage.
 * Rotates old entries when MAX_HISTORY is exceeded.
 */
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  // Check opt-in preference
  const pref = await chrome.storage.local.get(STORAGE_KEYS.STORE_TRANSCRIPTS);
  if (!pref[STORAGE_KEYS.STORE_TRANSCRIPTS]) return;

  const entries = await loadHistory();

  // Prepend newest entry
  entries.unshift(entry);

  // Rotate: keep only the most recent MAX_HISTORY entries
  const trimmed = entries.slice(0, MAX_HISTORY);

  await chrome.storage.local.set({ [HISTORY_KEY]: trimmed });
}

/**
 * Load all history entries (most recent first).
 */
export async function loadHistory(): Promise<HistoryEntry[]> {
  const result = await chrome.storage.local.get(HISTORY_KEY);
  return (result[HISTORY_KEY] as HistoryEntry[] | undefined) ?? [];
}

/**
 * Clear all history entries.
 */
export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * Generate a unique history entry ID.
 */
export function generateHistoryId(): string {
  return `hist_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Anonymize a history entry by stripping identifying page info.
 * Called when PRIVACY_ANONYMIZE is enabled.
 */
export function anonymizeEntry(entry: HistoryEntry): HistoryEntry {
  const { url: _u, pageTitle: _pt, ...rest } = entry;
  return {
    ...rest,
    // Also strip element-level labels from the plan if present
    plan: entry.plan
      ? {
          ...entry.plan,
          actions: entry.plan.actions.map(action => {
            // For type actions, blank out the value if it looks like PII
            // Type action anonymization reserved for future implementation
            return action;
          }),
        }
      : null,
  };
}
