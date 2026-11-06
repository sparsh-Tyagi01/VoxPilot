/**
 * @file src/shared/macros.ts
 * @description Macro (saved workflow) types and storage helpers.
 *
 * A Macro is a user-recorded sequence of AgentActions that can be replayed
 * by voice command ("Do my morning routine", "Fill the login form").
 *
 * SRS references:
 * - FR-MACRO-01: Record a macro by voice ("Remember this as X")
 * - FR-MACRO-02: Play back a macro by voice command
 * - FR-MACRO-03: List and delete macros from settings
 * - NFR-PRV-01: Macros stored in chrome.storage.local (on-device only)
 */

import type { AgentAction } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/** A saved macro: a named sequence of actions. */
export interface Macro {
  /** Stable unique ID (UUID-like, generated at recording time). */
  id: string;
  /** User-given name used to trigger the macro by voice. */
  name: string;
  /** Lowercase trigger words derived from name (for fuzzy matching). */
  triggerWords: string[];
  /** The recorded actions to replay. */
  actions: AgentAction[];
  /** ISO 8601 timestamp of when the macro was created. */
  createdAt: string;
  /** Number of times the macro has been used. */
  useCount: number;
  /** URL pattern the macro was recorded on (for context-aware suggestions). */
  recordedOnUrl?: string;
}

/** Storage key for macros in chrome.storage.local. */
export const MACROS_STORAGE_KEY = "voxpilot_macros_v1";

/** Maximum number of macros a user can save. */
export const MAX_MACROS = 50;

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Generate a simple collision-resistant ID.
 * We don't need cryptographic randomness here — just uniqueness.
 */
export function generateMacroId(): string {
  return `macro_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "in", "on", "at", "to", "for", "of", "and", "or",
  "please", "can", "you", "me", "my", "this", "that", "it",
]);

/**
 * Derive trigger words from a macro name for voice matching.
 * Lowercases, strips punctuation, and removes common stop words.
 */
export function deriveTriggerWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

/**
 * Load all macros from chrome.storage.local.
 */
export async function loadMacros(): Promise<Macro[]> {
  const result = await chrome.storage.local.get(MACROS_STORAGE_KEY);
  return (result[MACROS_STORAGE_KEY] as Macro[] | undefined) ?? [];
}

/**
 * Persist the macro list to chrome.storage.local.
 */
export async function saveMacros(macros: Macro[]): Promise<void> {
  await chrome.storage.local.set({ [MACROS_STORAGE_KEY]: macros });
}

/**
 * Find a macro whose trigger words best match the spoken command.
 *
 * Uses a simple word-overlap score: (matching words / total trigger words).
 * Returns the macro with the highest score above the threshold, or null.
 *
 * @param transcript The normalised voice command to match against.
 * @param macros     The list of saved macros.
 * @param threshold  Minimum score to consider a match (0–1). Default: 0.6
 */
export function findMatchingMacro(
  transcript: string,
  macros: Macro[],
  threshold = 0.6
): Macro | null {
  if (macros.length === 0) return null;

  const spoken = new Set(
    transcript
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1)
  );

  let bestMacro: Macro | null = null;
  let bestScore = threshold - 0.001;

  for (const macro of macros) {
    if (macro.triggerWords.length === 0) continue;

    const matches = macro.triggerWords.filter(w => spoken.has(w)).length;
    const score = matches / macro.triggerWords.length;

    if (score > bestScore) {
      bestScore = score;
      bestMacro = macro;
    }
  }

  return bestMacro;
}

