/**
 * @file src/shared/messages.ts
 * @description Discriminated-union message types for all Chrome runtime messages
 * between VoxPilot components.
 *
 * Message routing topology:
 *
 *   Panel ──────────────────────────────────────────────────► SW
 *   SW ─────────────────────────────────────────────────────► Panel
 *   SW ─────────────────────────────────────────────────────► Offscreen
 *   Offscreen ──────────────────────────────────────────────► SW
 *   SW ─────────────────────────────────────────────────────► Content (via tabs.sendMessage)
 *   Content ─────────────────────────────────────────────────► SW (via runtime.sendMessage)
 *
 * All messages implement the `BaseMessage` interface and are narrowed by `type`.
 *
 * Usage:
 * ```ts
 * chrome.runtime.sendMessage({ type: 'TOGGLE_LISTENING' } satisfies ToggleListeningMsg);
 * chrome.runtime.onMessage.addListener((msg: VoxPilotMessage) => {
 *   switch (msg.type) { ... }
 * });
 * ```
 */

import type {
  AgentPlan,
  AgentState,
  PageSnapshot,
  SessionState,
  AuditEntry,
} from "./types.js";

// ─── Base ─────────────────────────────────────────────────────────────────────

/** All VoxPilot messages carry a `type` discriminant. */
export interface BaseMessage {
  readonly type: string;
  readonly target?: "sw" | "offscreen" | "ui";
}

// ─── Panel → SW Messages ──────────────────────────────────────────────────────

/** User pressed the mic button in the side panel. */
export interface ToggleListeningMsg extends BaseMessage {
  type: "TOGGLE_LISTENING";
}

/** User pressed "Confirm" in the confirmation overlay. */
export interface ConfirmPlanMsg extends BaseMessage {
  type: "CONFIRM_PLAN";
}

/** User pressed "Cancel" in the confirmation overlay. */
export interface CancelPlanMsg extends BaseMessage {
  type: "CANCEL_PLAN";
}

/** User pressed "Undo" to reverse the last reversible action. */
export interface UndoLastActionMsg extends BaseMessage {
  type: "UNDO_LAST_ACTION";
}

/** User triggered a saved macro by name. */
export interface TriggerMacroMsg extends BaseMessage {
  type: "TRIGGER_MACRO";
  macroId: string;
}

/** Panel requesting current session state (for initialization). */
export interface GetModelStatusMsg extends BaseMessage {
  type: "GET_MODEL_STATUS";
}

export interface GetSessionStateMsg extends BaseMessage {
  type: "GET_SESSION_STATE";
}

// ─── SW → Panel Messages ──────────────────────────────────────────────────────

/** Full session state snapshot pushed to the panel on any change. */
export interface SessionStateUpdateMsg extends BaseMessage {
  type: "SESSION_STATE_UPDATE";
  state: SessionState;
}

/** Live transcript word(s) streamed during Transcribing state. */
export interface TranscriptUpdateMsg extends BaseMessage {
  type: "TRANSCRIPT_UPDATE";
  /** Partial or final transcript text */
  text: string;
  /** Whether this is the final (complete) transcript for this utterance */
  isFinal: boolean;
}

/** A new plan is ready for display (Confirming state). */
export interface PlanReadyMsg extends BaseMessage {
  type: "PLAN_READY";
  plan: AgentPlan;
}

/** Agent state changed (drives UI rendering in panel). */
export interface AgentStateChangedMsg extends BaseMessage {
  type: "AGENT_STATE_CHANGED";
  state: AgentState;
  /** Optional error message when state === AgentState.Error */
  error?: string;
}

/** An action was completed; update execution progress in panel. */
export interface ActionCompletedMsg extends BaseMessage {
  type: "ACTION_COMPLETED";
  actionIndex: number;
  totalActions: number;
}

/** TTS is about to speak this text (for display in panel). */
export interface SpeakingMsg extends BaseMessage {
  type: "SPEAKING";
  text: string;
}

// ─── SW → Offscreen Messages ──────────────────────────────────────────────────

/** SW instructs offscreen to start the audio pipeline. */
export interface StartAudioMsg extends BaseMessage {
  type: "START_AUDIO";
  /** Optional model profile to use (selected during onboarding). Defaults to "lite". */
  profile?: string;
}

/** SW instructs offscreen to stop the audio pipeline. */
export interface StopAudioMsg extends BaseMessage {
  type: "STOP_AUDIO";
}

/** SW relays a confirmed plan to offscreen for execution. */
export interface ExecutePlanMsg extends BaseMessage {
  type: "EXECUTE_PLAN";
  plan: AgentPlan;
  tabId: number;
}

/** SW relays the page snapshot to offscreen for LLM planning. */
export interface PageSnapshotMsg extends BaseMessage {
  type: "PAGE_SNAPSHOT";
  snapshot: PageSnapshot;
}

/** SW relays user's answer to an `ask` action. */
export interface UserAnswerMsg extends BaseMessage {
  type: "USER_ANSWER";
  answer: string;
}

/** Keepalive ping from SW alarm to prevent offscreen GC. */
export interface KeepaliveMsg extends BaseMessage {
  type: "KEEPALIVE";
}

/** Real-time microphone audio level (VU meter) and speech activity. */
export interface AudioLevelMsg extends BaseMessage {
  type: "AUDIO_LEVEL";
  /** RMS volume normalized between 0 and 1 */
  level: number;
  /** Whether VAD or energy detection currently considers this speech */
  isSpeech: boolean;
}

/** Direct speech transcript from Web Speech API (zero-latency fast path). */
export interface DirectTranscriptMsg extends BaseMessage {
  type: "DIRECT_TRANSCRIPT";
  text: string;
}

/** SW instructs offscreen to plan and execute a natural language voice command. */
export interface ExecuteTextCommandMsg extends BaseMessage {
  type: "EXECUTE_TEXT_COMMAND";
  text: string;
}

// ─── Offscreen → SW Messages ──────────────────────────────────────────────────

/** STT produced a transcript. */
export interface TranscriptMsg extends BaseMessage {
  type: "TRANSCRIPT";
  text: string;
  confidence: number | null;
  language: string;
  isFinal: boolean;
}

/** LLM produced a plan (not yet validated). */
export interface PlanProducedMsg extends BaseMessage {
  documentId?: string;
  type: "PLAN_PRODUCED";
  plan: AgentPlan;
}

/** Offscreen needs the current page snapshot for planning. */
export interface RequestSnapshotMsg extends BaseMessage {
  includeText?: boolean;
  type: "REQUEST_SNAPSHOT";
  tabId: number;
}

/** Offscreen signals an internal error. */
export interface OffscreenErrorMsg extends BaseMessage {
  type: "OFFSCREEN_ERROR";
  source: "audio" | "stt" | "llm" | "tts" | "agent";
  message: string;
  stack?: string;
}

/** Offscreen signals that TTS playback finished. */
export interface TtsDoneMsg extends BaseMessage {
  type: "TTS_DONE";
}

/** Offscreen reports STT/LLM model download progress. */
export interface ModelLoadProgressMsg extends BaseMessage {
  profile?: string;
  loadId?: string;
  type: "MODEL_LOAD_PROGRESS";
  progress?: number;
  loaded?: number;
  total?: number;
  done?: boolean;
  phase?: string;
  text?: string;
  stt?: { loaded: number; total: number; ready?: boolean };
  llm?: { loaded: number; total: number; text?: string; ready?: boolean };
}

/** Offscreen streams a single LLM output token to the panel. */
export interface LlmTokenMsg extends BaseMessage {
  type: "LLM_TOKEN";
  delta: string;
}

/** Offscreen requests SW to relay an action to the content script. */
export interface RelayActionMsg extends BaseMessage {
  type: "RELAY_ACTION";
  tabId: number;
  plan: AgentPlan;
}

// ─── SW → Content Script Messages ─────────────────────────────────────────────

/** SW instructs content script to capture a DOM snapshot. */
export interface CaptureSnapshotMsg extends BaseMessage {
  includeText?: boolean;
  type: "CAPTURE_SNAPSHOT";
}

/** SW instructs content script to execute a plan. */
export interface ExecuteInPageMsg extends BaseMessage {
  documentId?: string;
  type: "EXECUTE_IN_PAGE";
  plan: AgentPlan;
}

/** SW instructs content script to show numbered badges. */
export interface ShowBadgesMsg extends BaseMessage {
  type: "SHOW_BADGES";
  /** Handle IDs to badge */
  handles: string[];
}

/** SW instructs content script to hide all badges. */
export interface HideBadgesMsg extends BaseMessage {
  type: "HIDE_BADGES";
}

/** SW instructs content script to highlight a specific element. */
export interface HighlightElementMsg extends BaseMessage {
  type: "HIGHLIGHT_ELEMENT";
  handle: string;
}

/** SW instructs content script to show/update listening state indicator. */
export interface ShowListeningMsg extends BaseMessage {
  type: "SHOW_LISTENING";
  agentState: import("./types.js").AgentState;
}

/** SW pings a content script to check if it's alive. */
export interface PingMsg extends BaseMessage {
  type: "PING";
}

/** SW instructs content script to show a confirmation prompt. */
export interface ShowConfirmationMsg extends BaseMessage {
  type: "SHOW_CONFIRMATION";
  plan: AgentPlan;
}

/** SW instructs content script to hide the confirmation overlay. */
export interface HideConfirmationMsg extends BaseMessage {
  type: "HIDE_CONFIRMATION";
}

// ─── Content Script → SW Messages ─────────────────────────────────────────────

/** Content script responds with a captured DOM snapshot. */
export interface SnapshotResponseMsg extends BaseMessage {
  type: "SNAPSHOT_RESPONSE";
  snapshot: PageSnapshot;
}

/** Content script completed executing the plan. */
export interface ExecutionDoneMsg extends BaseMessage {
  type: "EXECUTION_DONE";
  success: boolean;
  error?: string;
}

/** Content script relays user confirmation from the in-page overlay. */
export interface InPageConfirmMsg extends BaseMessage {
  type: "IN_PAGE_CONFIRM";
  confirmed: boolean;
}

// ─── Audit Messages ───────────────────────────────────────────────────────────

/** Panel requests audit log entries. */
export interface GetAuditLogMsg extends BaseMessage {
  type: "GET_AUDIT_LOG";
  /** Max entries to return (default 50) */
  limit?: number;
}

/** Panel requests to save a new macro. */
export interface SaveMacroMsg extends BaseMessage {
  type: "SAVE_MACRO";
  name: string;
  actions: import("./types.js").AgentAction[];
}

/** Panel requests to delete a macro by ID. */
export interface DeleteMacroMsg extends BaseMessage {
  type: "DELETE_MACRO";
  macroId: string;
}

/** Panel requests the full macro list. */
export interface GetMacrosMsg extends BaseMessage {
  type: "GET_MACROS";
}

/** Panel requests history clear. */
export interface ClearHistoryMsg extends BaseMessage {
  type: "CLEAR_HISTORY";
}

// ─── Vault Fill (FR-VAULT-04) ──────────────────────────────────────────────

/**
 * Content script asks SW to resolve a vault field and relay it back.
 * The field key (e.g. "email") is passed; the decrypted value is returned
 * directly to the content script's tab — it NEVER traverses to offscreen/LLM.
 */
export interface VaultFillRequestMsg extends BaseMessage {
  type: "VAULT_FILL_REQUEST";
  /** Vault field key (e.g. "email", "password"). */
  fieldKey: string;
  /** DOM handle of the target input element. */
  handle: string;
}

/**
 * SW relays the decrypted vault value back to the content script.
 * Lives in memory only — never logged, never sent to offscreen.
 */
export interface VaultFillResponseMsg extends BaseMessage {
  type: "VAULT_FILL_RESPONSE";
  /** DOM handle of the target input element (echoed from request). */
  handle: string;
  /** Decrypted field value — only lives in memory, never logged. */
  value: string;
}

/**
 * SW → Panel: request the user to enter their vault passphrase.
 * Sent when a vault fill is requested but the vault is locked.
 */
export interface VaultPassphraseRequestMsg extends BaseMessage {
  type: "VAULT_PASSPHRASE_REQUEST";
  /** Pending request ID so the response can be correlated. */
  requestId: string;
}

/**
 * Panel → SW: user submitted their vault passphrase.
 */
export interface VaultPassphraseResponseMsg extends BaseMessage {
  type: "VAULT_PASSPHRASE_RESPONSE";
  requestId: string;
  passphrase: string;
}

/**
 * SW → Panel: vault unlock failed (wrong passphrase).
 */
export interface VaultUnlockFailedMsg extends BaseMessage {
  type: "VAULT_UNLOCK_FAILED";
  requestId: string;
}

/** SW responds with audit log. */
export interface AuditLogResponseMsg extends BaseMessage {
  type: "AUDIT_LOG_RESPONSE";
  entries: AuditEntry[];
}

// ─── Settings / Model Management ─────────────────────────────────────────────

/** Settings page notifies SW that the model profile changed. */
export interface ProfileChangedMsg extends BaseMessage {
  type: "PROFILE_CHANGED";
  profile: string;
}

/** Onboarding requests SW to start model download with a given profile. */
export interface StartModelDownloadMsg extends BaseMessage {
  type: "START_MODEL_DOWNLOAD";
  profile: string;
}

// ─── Tab / Navigation ────────────────────────────────────────────────────────

/** Content script requests a tab operation (requires chrome.tabs API, only in SW). */
export interface TabOperationMsg extends BaseMessage {
  type: "TAB_OPERATION";
  operation: "open" | "close" | "switch";
  url?: string;
  index?: number;
}

// ─── TTS ─────────────────────────────────────────────────────────────────────

/** Content script requests TTS (from a "read" action summary or "ask" response). */
export interface SpeakMsg extends BaseMessage {
  type: "SPEAK";
  text: string;
}

// ─── Discriminated Union ──────────────────────────────────────────────────────

/** All possible VoxPilot inter-component messages. */
export interface PerformanceSampleMsg extends BaseMessage {
  type: "PERFORMANCE_SAMPLE";
  sample: import("../diagnostics/metrics.js").PerformanceSample;
}
export interface GetDiagnosticsMsg extends BaseMessage { type: "GET_DIAGNOSTICS"; }

export interface CommandNoticeMsg extends BaseMessage { type: "COMMAND_NOTICE"; text: string; }
export interface VaultLockMsg extends BaseMessage { type: "VAULT_LOCK"; }

export type VoxPilotMessage = VaultLockMsg | CommandNoticeMsg | PerformanceSampleMsg | GetDiagnosticsMsg
  /* Panel → SW */
  | ToggleListeningMsg
  | ConfirmPlanMsg
  | CancelPlanMsg
  | UndoLastActionMsg
  | TriggerMacroMsg
  | GetSessionStateMsg
  | GetModelStatusMsg
  | DirectTranscriptMsg
  /* SW → Panel */
  | SessionStateUpdateMsg
  | TranscriptUpdateMsg
  | PlanReadyMsg
  | AgentStateChangedMsg
  | ActionCompletedMsg
  | SpeakingMsg
  | AudioLevelMsg
  | DirectTranscriptMsg
  /* SW → Offscreen */
  | StartAudioMsg
  | StopAudioMsg
  | ExecutePlanMsg
  | ExecuteTextCommandMsg
  | PageSnapshotMsg
  | UserAnswerMsg
  | KeepaliveMsg
  /* Offscreen → SW */
  | TranscriptMsg
  | PlanProducedMsg
  | RequestSnapshotMsg
  | OffscreenErrorMsg
  | TtsDoneMsg
  | ModelLoadProgressMsg
  | LlmTokenMsg
  | RelayActionMsg
  | AudioLevelMsg
  /* SW → Content */
  | CaptureSnapshotMsg
  | ExecuteInPageMsg
  | ShowBadgesMsg
  | HideBadgesMsg
  | HighlightElementMsg
  | ShowListeningMsg
  | PingMsg
  | ShowConfirmationMsg
  | HideConfirmationMsg
  /* Content → SW */
  | SnapshotResponseMsg
  | ExecutionDoneMsg
  | InPageConfirmMsg
  /* Audit */
  | GetAuditLogMsg
  | AuditLogResponseMsg
  | SaveMacroMsg
  | DeleteMacroMsg
  | GetMacrosMsg
  | ClearHistoryMsg
  /* Vault fill (FR-VAULT-04) */
  | VaultFillRequestMsg
  | VaultFillResponseMsg
  | VaultPassphraseRequestMsg
  | VaultPassphraseResponseMsg
  | VaultUnlockFailedMsg
  /* Settings / Model management */
  | ProfileChangedMsg
  | StartModelDownloadMsg
  /* Tab / Navigation */
  | TabOperationMsg
  /* TTS */
  | SpeakMsg;

/** Utility: extract a message type by its `type` discriminant. */
export type MessageByType<T extends VoxPilotMessage["type"]> = Extract<
  VoxPilotMessage,
  { type: T }
>;
