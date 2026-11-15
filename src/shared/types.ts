/**
 * @file src/shared/types.ts
 * @description Canonical TypeScript type definitions shared across all VoxPilot
 * components: service worker, offscreen document, content scripts, and panels.
 *
 * Design principles:
 * - All action types use discriminated unions for exhaustive type narrowing.
 * - Enums use `const enum` where possible to avoid runtime overhead.
 * - No circular imports — this file must import from no other VoxPilot module.
 */

// ─── Agent Lifecycle State ────────────────────────────────────────────────────

/**
 * Top-level state machine states for the VoxPilot agent.
 * Transitions are strictly enforced in agent-core.ts.
 */
export enum AgentState {
  /** Microphone inactive, agent dormant */
  Idle = "Idle",
  /** VAD active, capturing audio, waiting for speech */
  Listening = "Listening",
  /** Speech detected, Whisper worker transcribing */
  Transcribing = "Transcribing",
  /** Transcript received, routing to fast-path or LLM */
  Routing = "Routing",
  /** LLM generating an AgentPlan */
  Planning = "Planning",
  /** Waiting for user confirmation (R3/R4 risk actions) */
  Confirming = "Confirming",
  /** Actions being dispatched to content script */
  Executing = "Executing",
  /** TTS synthesising/playing agent speech */
  Speaking = "Speaking",
  /** Unrecoverable error; user must acknowledge to return to Idle */
  Error = "Error",
}

// ─── Risk Classification ──────────────────────────────────────────────────────

/**
 * Risk tier assigned to each AgentPlan by the risk classifier.
 * Determines whether user confirmation is required before execution.
 *
 * | Tier | Description                                    | Confirm? |
 * |------|------------------------------------------------|----------|
 * | R0   | Read-only (scroll, read page)                  | No       |
 * | R1   | Reversible single-field input (type in input)  | No       |
 * | R2   | Multi-field or in-page navigation              | No       |
 * | R3   | Form submit, file operation, in-app purchase   | Yes      |
 * | R4   | Account deletion, payment, irreversible action | Yes      |
 */
export enum RiskTier {
  R0 = 0,
  R1 = 1,
  R2 = 2,
  R3 = 3,
  R4 = 4,
}

// ─── Model Profiles ───────────────────────────────────────────────────────────

/**
 * Selectable model capability profiles.
 * Lower = faster but less capable; Higher = slower but smarter.
 */
export enum ModelProfile {
  Essential = "essential",
  /** Llama 3.2 1B — fastest, lowest memory (~700 MB) */
  Fast = "fast",
  /** Llama 3.2 3B — balanced */
  Balanced = "balanced",
  /** Llama 3.1 8B — most capable, requires ≥8 GB GPU RAM */
  Powerful = "powerful",
}

// ─── Action Types ─────────────────────────────────────────────────────────────

/** Click an element identified by its set-of-marks handle. */
export interface ClickAction {
  type: "click";
  /** Element handle from the DOM snapshot */
  handle: string;
  /** Optional human-readable label for TTS confirmation */
  label?: string;
}

/** Type text into a focused element using synthetic keyboard events. */
export interface TypeAction {
  type: "type";
  /** Target element handle */
  handle: string;
  /** Text to type */
  text: string;
  /** If true, clear existing text before typing */
  clear?: boolean;
}

/** Change a <select> element's value by option text or value attribute. */
export interface SelectAction {
  type: "select";
  handle: string;
  /** Option text (displayed) or value attribute */
  option: string;
}

/** Toggle a checkbox or radio button. */
export interface ToggleAction {
  type: "toggle";
  handle: string;
  /** Desired checked state */
  checked: boolean;
}

/** Scroll the page or a scrollable container. */
export interface ScrollAction {
  type: "scroll";
  /** Handle of scrollable element, or null for window scroll */
  handle: string | null;
  /** Scroll direction */
  direction: "up" | "down" | "left" | "right";
  /** Scroll amount in pixels (default: 300) */
  amount?: number;
}

/** Navigate to a URL. */
export interface NavigateAction {
  type: "navigate";
  url: string;
}

/** Browser tab operations. */
export interface TabAction {
  type: "tab";
  operation: "open" | "close" | "switch";
  /** URL for open operation */
  url?: string;
  /** Tab index for switch operation (0-based) */
  index?: number;
}

/**
 * Read text content from the page and speak it via TTS.
 * This is a read-only R0 action.
 */
export interface ReadAction {
  type: "read";
  /** Handle of element to read, or null to read page title + main content */
  handle: string | null;
}

/**
 * Fill a form field from the encrypted vault.
 * The vault field name is resolved at execution time — the LLM never sees the value.
 */
export interface FillFromVaultAction {
  type: "fill_from_vault";
  handle: string;
  /** Key in the vault (e.g. "email", "password", "creditCard.number") */
  vaultField: VaultFieldKey;
}

/**
 * Ask the user a clarifying question via TTS + confirmation overlay.
 * Agent waits for voice or button response before continuing.
 */
export interface AskAction {
  type: "ask";
  question: string;
  /** Suggested reply options shown as buttons in the panel */
  options?: string[];
}

/** Terminal action: plan complete, nothing more to do. */
export interface DoneAction {
  type: "done";
  /** Summary spoken to the user via TTS */
  summary: string;
}

/** Discriminated union of all possible agent actions. */
export type AgentAction =
  | ClickAction
  | TypeAction
  | SelectAction
  | ToggleAction
  | ScrollAction
  | NavigateAction
  | TabAction
  | ReadAction
  | FillFromVaultAction
  | AskAction
  | DoneAction;

/** All action type string literals (useful for switch exhaustiveness). */
export type AgentActionType = AgentAction["type"];

// ─── Agent Plan ───────────────────────────────────────────────────────────────

/**
 * The structured output produced by the LLM and validated against the JSON schema.
 * See src/shared/schema.ts for the full JSON Schema definition.
 */
export interface AgentPlan {
  /** Natural language restatement of the user's intent (for TTS confirmation) */
  intent: string;
  /** Ordered list of actions to execute */
  actions: AgentAction[];
  /**
   * Pre-classified risk tier from the LLM.
   * The risk-classifier.ts will verify and may escalate this.
   */
  risk: RiskTier;
  /** Whether the LLM requests user confirmation before executing */
  requiresConfirmation: boolean;
}

// ─── DOM Snapshot ─────────────────────────────────────────────────────────────

/**
 * Compact representation of an interactive DOM element, produced by snapshot.ts
 * and sent to the offscreen document for LLM context.
 */
export interface ElementHandle {
  /** Stable handle ID (e.g. "e42") assigned by handles.ts */
  handle: string;
  /** Element tag name (lowercase) */
  tag: string;
  /** Element type attribute (for inputs) */
  inputType?: string;
  /** aria-role or implicit ARIA role */
  role?: string;
  /** aria-label, label text, button text, or placeholder */
  label?: string;
  /** Current value (for inputs, selects) — truncated to 100 chars */
  value?: string;
  /** Whether the element is currently disabled */
  disabled?: boolean;
  /** Whether the element is currently visible in viewport */
  inViewport?: boolean;
  /** Bounding rect (used for scroll/badge positioning) */
  rect?: DOMRect;
}

/**
 * Full snapshot of the current page state, sent to the LLM as context.
 */
export interface PageSnapshot {
  documentId?: string;
  revision?: number;
  /** Current page URL */
  url: string;
  /** document.title */
  title: string;
  /** All interactive elements found by snapshot.ts */
  elements: ElementHandle[];
  /** Key headings found on page (h1, h2, h3) */
  headings?: string[];
  /** Brief extract of readable page content (first 2,000 chars) */
  textSummary?: string;
  /** Timestamp when snapshot was captured (ms since epoch) */
  capturedAt: number;
  /** Whether the snapshot was truncated (> MAX_ELEMENTS) */
  truncated: boolean;
}

// ─── Vault ────────────────────────────────────────────────────────────────────

/**
 * Allowed vault field keys.
 * Hierarchy uses dot notation (e.g. "creditCard.number").
 */
export type VaultFieldKey =
  | "email"
  | "username"
  | "password"
  | "fullName"
  | "firstName"
  | "lastName"
  | "phone"
  | "address.line1"
  | "address.line2"
  | "address.city"
  | "address.state"
  | "address.zip"
  | "address.country"
  | "creditCard.number"
  | "creditCard.expiry"
  | "creditCard.cvv"
  | "creditCard.name";

/**
 * A single vault entry. Values are stored encrypted; the in-memory
 * representation after unlock holds plaintext strings.
 */
export interface VaultField {
  key: VaultFieldKey;
  /** Display name shown in settings UI */
  displayName: string;
  /** Plaintext value (only in-memory after vault unlock) */
  value: string;
  /** Whether this field should be masked in audit logs */
  sensitive: boolean;
}

// ─── Session State ────────────────────────────────────────────────────────────

/**
 * Complete session state stored in chrome.storage.session.
 * The service worker is stateless — all runtime state lives here.
 */
export interface SessionState {
  siteTask?: import("./site-task.js").SiteTaskState | null;
  agentState: AgentState;
  /** ID of the currently active tab being automated */
  activeTabId: number | null;
  /** Most recent transcript from STT */
  lastTranscript: string;
  /** Current plan being confirmed/executed */
  currentPlan: AgentPlan | null;
  currentDocumentId?: string | null;
  /** Identifies the plan that may still execute after async page work. */
  executionId?: string | null;
  /** Whether the offscreen document is alive */
  offscreenActive: boolean;
  /** Whether voice listening is toggled on */
  listeningEnabled: boolean;
  /** Timestamp of last keepalive ping (ms since epoch) */
  lastKeepalive: number;
  /** Number of consecutive errors (for backoff) */
  errorCount: number;
}

// ─── Macro ────────────────────────────────────────────────────────────────────

/**
 * A saved voice macro — a named sequence of actions.
 */
export interface Macro {
  id: string;
  /** User-given name, also the voice trigger phrase */
  name: string;
  /** Actions to execute when triggered */
  plan: AgentPlan;
  /** Creation timestamp */
  createdAt: number;
  /** Usage count */
  useCount: number;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

/**
 * A single audit log entry for the privacy dashboard.
 */
export interface AuditEntry {
  id: string;
  timestamp: number;
  /** Original transcript (never stored if user opts out of logs) */
  transcript?: string;
  /** Intent string from the plan */
  intent: string;
  /** Actions executed (sensitive values redacted) */
  actions: AgentAction[];
  riskTier: RiskTier;
  /** Whether user confirmed the action */
  confirmed: boolean;
  /** Whether the action was undone */
  undone: boolean;
  pageUrl: string;
  pageTitle: string;
}
