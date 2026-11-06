/**
 * @file src/panel/panel.ts
 * @description Side panel logic for VoxPilot.
 *
 * The panel provides the primary user interface:
 * - Live transcript display (aria-live for screen reader support)
 * - Plan preview with step progress
 * - Confirmation UI for R3/R4 risk actions
 * - Command history with undo buttons
 * - Settings and privacy links
 *
 * SRS references: IR-UI-04; FR-HIST-01 to 03; Section 3.1 (Side panel)
 *
 * Architecture: Panel communicates exclusively via chrome.runtime.sendMessage
 * to the Service Worker — it never touches the offscreen document or content
 * scripts directly.
 */

import type { VoxPilotMessage } from "@shared/messages.js";
import type { AgentPlan, SessionState } from "@shared/types.js";
import { AgentState, RiskTier } from "@shared/types.js";

// ─── DOM References ───────────────────────────────────────────────────────────

const statusDot    = document.getElementById("status-dot")!;
const statusText   = document.getElementById("status-text")!;
const toggleBtn    = document.getElementById("toggle-btn") as HTMLButtonElement;
const toggleIcon   = document.getElementById("toggle-icon")!;
const toggleLabel  = document.getElementById("toggle-label")!;
const transcriptBox = document.getElementById("transcript-box")!;
const planSection  = document.getElementById("plan-section") as HTMLElement;
const planIntentEl = document.getElementById("plan-intent-text")!;
const riskPill     = document.getElementById("risk-pill")!;
const planActionsEl = document.getElementById("plan-actions")!;
const confirmBtns  = document.getElementById("confirm-buttons") as HTMLElement;
const btnCancel    = document.getElementById("btn-cancel") as HTMLButtonElement;
const btnConfirm   = document.getElementById("btn-confirm") as HTMLButtonElement;
const historyList  = document.getElementById("history-list")!;
const historyEmpty = document.getElementById("history-empty")!;
const btnSettings  = document.getElementById("btn-settings") as HTMLButtonElement;
const btnPrivacy   = document.getElementById("btn-privacy") as HTMLButtonElement;
const btnHelp      = document.getElementById("btn-help") as HTMLButtonElement;

// ─── State ────────────────────────────────────────────────────────────────────

let currentPlan: AgentPlan | null = null;
let isListening = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const RISK_LABELS = ["R0", "R1", "R2", "R3", "R4"] as const;

const STATE_CONFIG: Record<string, { dot: string; label: string }> = {
  [AgentState.Idle]:         { dot: "",          label: "Idle" },
  [AgentState.Listening]:    { dot: "listening", label: "Listening" },
  [AgentState.Transcribing]: { dot: "thinking",  label: "Transcribing" },
  [AgentState.Routing]:      { dot: "thinking",  label: "Thinking" },
  [AgentState.Planning]:     { dot: "thinking",  label: "Planning" },
  [AgentState.Confirming]:   { dot: "thinking",  label: "Confirming" },
  [AgentState.Executing]:    { dot: "listening", label: "Executing" },
  [AgentState.Speaking]:     { dot: "listening", label: "Speaking" },
  [AgentState.Error]:        { dot: "error",     label: "Error" },
};

/** Update the status indicator. */
function updateStatus(state: string, error?: string): void {
  const cfg = STATE_CONFIG[state] ?? { dot: "", label: state };
  statusDot.className = `status-dot ${cfg.dot}`.trim();
  statusText.textContent = error ? `Error: ${error.slice(0, 40)}` : cfg.label;
}

/** Update the toggle button appearance. */
function updateToggleBtn(listening: boolean): void {
  isListening = listening;
  toggleBtn.setAttribute("aria-pressed", String(listening));
  toggleBtn.classList.toggle("active", listening);
  toggleIcon.textContent = listening ? "⏹️" : "🎙️";
  toggleLabel.textContent = listening ? "Stop Listening" : "Start Listening";
}

/** Render the plan preview section. */
function showPlan(plan: AgentPlan): void {
  currentPlan = plan;
  planSection.hidden = false;
  planIntentEl.textContent = plan.intent;

  // Risk pill
  riskPill.textContent = RISK_LABELS[plan.risk] ?? "R?";
  riskPill.className = `risk-pill risk-${plan.risk}`;

  // Actions list
  planActionsEl.innerHTML = "";
  for (const action of plan.actions) {
    const li = document.createElement("li");
    li.className = "plan-action";
    li.textContent = describeAction(action);
    planActionsEl.appendChild(li);
  }

  // Confirmation buttons for R3/R4
  const needsConfirm = plan.requiresConfirmation;
  confirmBtns.hidden = !needsConfirm;
}

/** Hide the plan section and clear state. */
function hidePlan(): void {
  currentPlan = null;
  planSection.hidden = true;
  confirmBtns.hidden = true;
}

/** Add an entry to the history list. */
function addHistory(plan: AgentPlan): void {
  historyEmpty.hidden = true;

  const item = document.createElement("div");
  item.className = "history-item";
  item.setAttribute("role", "listitem");

  const textEl = document.createElement("div");
  textEl.className = "history-item-text";
  const strong = document.createElement("strong");
  strong.textContent = plan.intent;
  textEl.appendChild(strong);
  textEl.append(` · R${plan.risk}`);

  const undoBtn = document.createElement("button");
  undoBtn.className = "btn-undo";
  undoBtn.textContent = "Undo";
  undoBtn.type = "button";
  undoBtn.setAttribute("aria-label", `Undo: ${plan.intent}`);
  undoBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "UNDO_LAST_ACTION" }).catch(console.error);
    item.remove();
    if (historyList.querySelectorAll(".history-item").length === 0) {
      historyEmpty.hidden = false;
    }
  });

  item.appendChild(textEl);
  if (plan.risk <= RiskTier.R2) {
    item.appendChild(undoBtn);
  }

  // Prepend newest first
  historyList.insertBefore(item, historyList.firstChild);

  // Cap at 20 entries
  const items = historyList.querySelectorAll(".history-item");
  if (items.length > 20) {
    items[items.length - 1]!.remove();
  }
}

/** Human-readable action description for plan preview. */
function describeAction(action: { type: string; [key: string]: unknown }): string {
  switch (action.type) {
    case "click":    return `Click "${action["label"] ?? action["handle"]}"`;
    case "type":     return `Type "${String(action["text"]).slice(0, 30)}"`;
    case "select":   return `Select "${action["option"]}"`;
    case "scroll":   return `Scroll ${action["direction"]}`;
    case "navigate": return `Go to ${String(action["url"]).slice(0, 40)}`;
    case "tab":      return `Tab: ${action["operation"]}`;
    case "read":     return "Read page";
    case "fill_from_vault": return `Fill from vault`;
    case "ask":      return `Ask: "${String(action["question"]).slice(0, 40)}"`;
    case "done":     return `✓ ${String(action["summary"]).slice(0, 40)}`;
    default:         return action.type as string;
  }
}

// ─── Message Listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((rawMsg: unknown) => {
  const msg = rawMsg as VoxPilotMessage;

  switch (msg.type) {
    case "SESSION_STATE_UPDATE": {
      const state = msg.state as SessionState;
      updateStatus(state.agentState);
      updateToggleBtn(state.listeningEnabled);
      if (!state.currentPlan) hidePlan();
      break;
    }

    case "TRANSCRIPT_UPDATE": {
      transcriptBox.textContent = msg.text;
      transcriptBox.classList.toggle("empty", !msg.text);
      break;
    }

    case "PLAN_READY": {
      showPlan(msg.plan);
      break;
    }

    case "AGENT_STATE_CHANGED": {
      updateStatus(msg.state, msg.error);
      if (msg.state === AgentState.Listening || msg.state === AgentState.Idle) {
        hidePlan();
      }
      break;
    }

    case "EXECUTION_DONE": {
      if (currentPlan) {
        addHistory(currentPlan);
        hidePlan();
      }
      break;
    }
  }
});

// ─── Button Handlers ──────────────────────────────────────────────────────────

toggleBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_LISTENING" }).catch(console.error);
});

btnConfirm.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CONFIRM_PLAN" }).catch(console.error);
  confirmBtns.hidden = true;
});

btnCancel.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_PLAN" }).catch(console.error);
  hidePlan();
});

btnSettings.addEventListener("click", () => {
  chrome.runtime.openOptionsPage?.() ??
    chrome.tabs.create({ url: chrome.runtime.getURL("src/settings/settings.html") });
});

btnPrivacy.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/settings/settings.html#privacy") });
});

btnHelp.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://github.com/sparsh/voxpilot#commands" });
});

// Keyboard shortcuts for confirm/cancel
document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!currentPlan?.requiresConfirmation) return;
  if (e.key === "Enter") btnConfirm.click();
  if (e.key === "Escape") btnCancel.click();
});

// ─── Initialise ───────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  try {
    const state = await chrome.runtime.sendMessage({ type: "GET_SESSION_STATE" }) as SessionState;
    if (state) {
      updateStatus(state.agentState);
      updateToggleBtn(state.listeningEnabled);
      if (state.lastTranscript) {
        transcriptBox.textContent = state.lastTranscript;
        transcriptBox.classList.remove("empty");
      }
      if (state.currentPlan) {
        showPlan(state.currentPlan);
      }
    }
  } catch {
    // Service worker may not be ready yet
    updateStatus(AgentState.Idle);
  }
}

init().catch(console.error);

