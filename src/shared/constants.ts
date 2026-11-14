/**
 * @file src/shared/constants.ts
 * @description All shared constants for VoxPilot.
 *
 * Keep all magic numbers, timeout values, storage keys, CSS class names,
 * and configuration limits in this single file so they're easy to audit
 * and adjust without hunting through the codebase.
 */

import { ModelProfile, RiskTier } from "./types.js";

// ─── Timing & Latency Budgets (milliseconds) ──────────────────────────────────

/** Maximum time the DOM snapshot builder may run before returning partial results. */
export const SNAPSHOT_TIMEOUT_MS = 50;

/** Time in ms after end-of-speech before VAD confirms the utterance is done. */
export const VAD_ENDPOINT_HANGOVER_MS = 300;

/** Maximum end-to-end latency budget from speech end to first TTS word. */
export const E2E_LATENCY_BUDGET_MS = 3_000;

/** Time before the offscreen document is considered stale and recreated. */
export const OFFSCREEN_KEEPALIVE_INTERVAL_MS = 25_000;

/** Alarm period for SW keepalive (Chrome alarms fire at ≥ 1 minute). */
export const SW_KEEPALIVE_ALARM_PERIOD_MINUTES = 1;

/** How long the vault stays unlocked after last use (ms). */
export const VAULT_AUTO_LOCK_MS = 5 * 60 * 1_000; // 5 minutes

/** Maximum time to wait for a content script to respond. */
export const CONTENT_SCRIPT_TIMEOUT_MS = 10_000;

/** Maximum time to wait for LLM to produce a plan. */
export const LLM_TIMEOUT_MS = 30_000;

/** Maximum time to wait for STT to transcribe an utterance.
 * First inference on CPU (WASM) can take 25-40s due to JIT compilation.
 * Subsequent inferences are typically 1-5s.
 */
export const STT_TIMEOUT_MS = 60_000;

/** Debounce delay for DOM mutations before re-snapshotting. */
export const DOM_MUTATION_DEBOUNCE_MS = 200;

/** Maximum age of a snapshot before requesting a fresh one (ms). */
export const SNAPSHOT_MAX_AGE_MS = 2_000;

// ─── Audio Pipeline ───────────────────────────────────────────────────────────

/** Sample rate for audio capture and STT (Whisper is trained on 16 kHz). */
export const AUDIO_SAMPLE_RATE = 16_000;

/** Maximum audio duration per STT inference chunk (seconds). */
export const STT_MAX_CHUNK_SECONDS = 30;

/** Minimum speech duration to send to STT (filters out click noises). */
export const MIN_SPEECH_DURATION_MS = 300;

/** Ring buffer size for audio capture (number of samples). */
export const AUDIO_RING_BUFFER_SIZE = AUDIO_SAMPLE_RATE * 60; // 60 seconds

// ─── DOM Snapshot Limits ──────────────────────────────────────────────────────

/** Maximum number of elements to include in a snapshot before truncating. */
export const MAX_SNAPSHOT_ELEMENTS = 300;

/** Maximum length of a label string in the snapshot (truncated beyond this). */
export const MAX_ELEMENT_LABEL_LENGTH = 150;

/** Maximum length of an element value in the snapshot. */
export const MAX_ELEMENT_VALUE_LENGTH = 100;

// ─── Agent Limits ─────────────────────────────────────────────────────────────

/** Maximum actions in a single AgentPlan. */
export const MAX_PLAN_ACTIONS = 20;

/** Maximum number of undo stack entries. */
export const UNDO_STACK_MAX = 10;

/** Maximum consecutive errors before the agent resets to Idle. */
export const MAX_CONSECUTIVE_ERRORS = 3;

// ─── Risk Tier Configuration ──────────────────────────────────────────────────

/**
 * Human-readable labels and confirmation requirements per risk tier.
 */
export const RISK_TIER_CONFIG: Record<
  RiskTier,
  {
    label: string;
    requiresConfirmation: boolean;
    description: string;
    color: string; // badge color in overlay
  }
> = {
  [RiskTier.R0]: {
    label: "Safe",
    requiresConfirmation: false,
    description: "Read-only action (scroll, read)",
    color: "#16a34a", // green-600
  },
  [RiskTier.R1]: {
    label: "Low",
    requiresConfirmation: false,
    description: "Reversible single-field input",
    color: "#2563eb", // blue-600
  },
  [RiskTier.R2]: {
    label: "Moderate",
    requiresConfirmation: false,
    description: "Multi-field or in-page navigation",
    color: "#d97706", // amber-600
  },
  [RiskTier.R3]: {
    label: "High",
    requiresConfirmation: true,
    description: "Form submission, file operation, in-app purchase",
    color: "#dc2626", // red-600
  },
  [RiskTier.R4]: {
    label: "Critical",
    requiresConfirmation: true,
    description: "Account deletion, payment, irreversible action",
    color: "#7c3aed", // violet-600
  },
};

// ─── Model Profiles ───────────────────────────────────────────────────────────

/**
 * Configuration for each selectable LLM model profile.
 */
export const MODEL_PROFILE_CONFIG: Record<
  ModelProfile,
  {
    label: string;
    /** WebLLM MLC model ID for LLM inference. */
    modelId: string;
    /** HuggingFace repo for the STT (Whisper) ONNX model. */
    sttModelId: string;
    /** Approximate VRAM/RAM required (MB) */
    memoryMb: number;
    /** Approximate tokens/second on a modern laptop GPU */
    tps: number;
    description: string;
  }
> = {
  [ModelProfile.Fast]: {
    label: "Fast (1B)",
    modelId: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    sttModelId: "onnx-community/whisper-tiny",
    memoryMb: 700,
    tps: 60,
    description: "Fastest response, works on all devices",
  },
  [ModelProfile.Balanced]: {
    label: "Balanced (3B)",
    modelId: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    sttModelId: "onnx-community/whisper-base",
    memoryMb: 1_800,
    tps: 30,
    description: "Good balance of speed and accuracy",
  },
  [ModelProfile.Powerful]: {
    label: "Powerful (8B)",
    modelId: "Llama-3.1-8B-Instruct-q4f16_1-MLC",
    sttModelId: "onnx-community/whisper-base",
    memoryMb: 5_000,
    tps: 12,
    description: "Best accuracy, requires a capable GPU",
  },
};

/** Default model profile on first install. */
export const DEFAULT_MODEL_PROFILE = ModelProfile.Fast;

// ─── Storage Keys ─────────────────────────────────────────────────────────────

/**
 * Keys used in chrome.storage.local (persisted across sessions).
 */
export const STORAGE_KEYS = {
  /** Encrypted vault blob */
  VAULT_BLOB: "vault_blob",
  /** User's chosen model profile */
  MODEL_PROFILE: "model_profile",
  /** Whether to store transcript history */
  STORE_TRANSCRIPTS: "store_transcripts",
  /** Audit log entries (array of AuditEntry) */
  AUDIT_LOG: "audit_log",
  /** Saved macros */
  MACROS: "macros",
  /** Onboarding completion flag */
  ONBOARDING_DONE: "onboarding_done",
  /** Preferred TTS voice URI */
  TTS_VOICE: "tts_voice",
  /** TTS speed (0.5–2.0) */
  TTS_SPEED: "tts_speed",
  /** Whether Set-of-Marks overlay is enabled */
  OVERLAY_ENABLED: "overlay_enabled",
  /** Privacy: whether to anonymize audit entries */
  PRIVACY_ANONYMIZE: "privacy_anonymize",
} as const;

/**
 * Keys used in chrome.storage.session (cleared on browser restart).
 * Service worker stores ALL runtime state here (never in module-level variables).
 */
export const SESSION_KEYS = {
  /** Serialized SessionState object */
  SESSION_STATE: "session_state",
  /** Whether the offscreen document is currently open */
  OFFSCREEN_ACTIVE: "offscreen_active",
  /** Whether the vault is currently unlocked */
  VAULT_UNLOCKED: "vault_unlocked",
  /** Vault unlock timestamp (for auto-lock) */
  VAULT_UNLOCK_TIME: "vault_unlock_time",
} as const;

// ─── Overlay CSS Classes ──────────────────────────────────────────────────────

/** CSS class applied to the overlay shadow host element. */
export const OVERLAY_HOST_CLASS = "voxpilot-overlay-host";

/** CSS class applied to individual Set-of-Marks badge elements. */
export const BADGE_CLASS = "voxpilot-badge";

/** CSS class applied to the confirmation dialog element. */
export const CONFIRMATION_CLASS = "voxpilot-confirmation";

/** Primary brand color (matches icon and panel accent). */
export const BRAND_COLOR = "#7c3aed"; // violet-700

/** Set-of-Marks badge background color. */
export const BADGE_COLOR = "#2563eb"; // blue-600

/** Badge text color. */
export const BADGE_TEXT_COLOR = "#ffffff";

/** Badge size in pixels. */
export const BADGE_SIZE_PX = 20;

/** Badge font size in pixels. */
export const BADGE_FONT_SIZE_PX = 11;

// ─── Alarm Names ─────────────────────────────────────────────────────────────

/** Name of the Chrome alarm used for SW keepalive. */
export const SW_KEEPALIVE_ALARM = "voxpilot-keepalive";

/** Name of the Chrome alarm used for vault auto-lock. */
export const VAULT_LOCK_ALARM = "voxpilot-vault-lock";

// ─── ARIA / Accessibility ─────────────────────────────────────────────────────

/** ARIA label for the main listening toggle button. */
export const ARIA_LISTENING_BUTTON = "Toggle voice listening";

/** ARIA label for the undo button. */
export const ARIA_UNDO_BUTTON = "Undo last action";

/** ARIA label for the confirm button. */
export const ARIA_CONFIRM_BUTTON = "Confirm action";

/** ARIA label for the cancel button. */
export const ARIA_CANCEL_BUTTON = "Cancel action";

// ─── URL Patterns ─────────────────────────────────────────────────────────────

/** Extension pages that should NOT have content scripts active. */
export const EXTENSION_PAGE_PATTERNS = [
  "chrome-extension://",
  "chrome://",
  "about:",
  "data:",
  "file://",
];

/** Model download CDN base URL. */
export const MODEL_CDN_BASE = "https://huggingface.co/mlc-ai";

// ─── Whisper Model Config ─────────────────────────────────────────────────────

/** HuggingFace repo for the Whisper ONNX model. */
export const WHISPER_MODEL_REPO = "onnx-community/whisper-tiny";

/** Whisper model files to cache locally. */
export const WHISPER_MODEL_FILES = [
  "encoder_model.onnx",
  "decoder_model_merged.onnx",
  "tokenizer.json",
  "tokenizer_config.json",
  "config.json",
  "generation_config.json",
];
