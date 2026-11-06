/**
 * @file src/panel/panel.ts
 * @description Side panel logic for VoxPilot.
 *
 * The panel provides the primary user interface:
 * - Live transcript display (aria-live for screen reader support)
 * - Streaming LLM token display (FR-MODEL-03)
 * - Model load progress bar (FR-MODEL-01)
 * - Plan preview with step progress
 * - Confirmation UI for R3/R4 risk actions
 * - Vault passphrase prompt (when vault is locked during fill_from_vault)
 * - Command history with undo buttons (FR-HIST-01)
 * - Macro recording trigger (FR-MACRO-01)
 * - Settings and privacy links
 *
 * SRS references: IR-UI-04; FR-HIST-01 to 03; FR-MACRO-01; Section 3.1 (Side panel)
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

// Audio meter references
const audioMeterWrap = document.getElementById("audio-meter-wrap") as HTMLElement;
const audioMeterText = document.getElementById("audio-meter-text") as HTMLElement;
const audioMeterStatus = document.getElementById("audio-meter-status") as HTMLElement;
const audioBars = document.getElementById("audio-bars") as HTMLElement;
const barSpans = audioBars ? (Array.from(audioBars.querySelectorAll(".bar")) as HTMLElement[]) : [];

// ─── State ────────────────────────────────────────────────────────────────────

let currentPlan: AgentPlan | null = null;

// ─── Model Load Progress Bar ─────────────────────────────────────────────────

/**
 * Inject a model-load progress bar above the transcript box if not already present.
 * Hidden by default; shown when MODEL_LOAD_PROGRESS messages arrive (FR-MODEL-01).
 */
function ensureProgressBar(): { bar: HTMLElement; fill: HTMLElement; label: HTMLElement } {
  let bar  = document.getElementById("model-progress-bar");
  let fill = document.getElementById("model-progress-fill");
  let label = document.getElementById("model-progress-label");

  if (!bar) {
    bar = document.createElement("div");
    bar.id = "model-progress-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", "0");
    bar.setAttribute("aria-label", "Model loading progress");
    bar.style.cssText = [
      "display:none", "height:4px", "background:var(--border,#e5e7eb)",
      "border-radius:2px", "overflow:hidden", "margin-bottom:8px",
    ].join(";");

    fill = document.createElement("div");
    fill.id = "model-progress-fill";
    fill.style.cssText = "height:100%;width:0%;background:var(--accent,#6366f1);transition:width 0.3s ease;";
    bar.appendChild(fill);

    label = document.createElement("div");
    label.id = "model-progress-label";
    label.setAttribute("aria-live", "polite");
    label.style.cssText = "display:none;font-size:11px;color:var(--muted,#6b7280);text-align:center;margin-bottom:4px;";

    // Insert before the transcript box
    transcriptBox.parentElement?.insertBefore(bar, transcriptBox);
    transcriptBox.parentElement?.insertBefore(label, transcriptBox);
  }

  return {
    bar: bar as HTMLElement,
    fill: fill as HTMLElement,
    label: label as HTMLElement,
  };
}

function showModelProgress(pct: number, phase: string, done: boolean): void {
  const { bar, fill, label } = ensureProgressBar();
  if (done) {
    bar.style.display = "none";
    label.style.display = "none";
    return;
  }
  bar.style.display = "block";
  label.style.display = "block";
  fill.style.width = `${pct}%`;
  bar.setAttribute("aria-valuenow", String(pct));
  label.textContent = pct < 100
    ? `${phase === "loading" ? "Loading" : "Downloading"} model… ${pct}%`
    : "Model ready";
}

// ─── LLM Streaming Tokens ────────────────────────────────────────────────────

/**
 * Append a streaming LLM token to the transcript area.
 * When the LLM is streaming its plan, we show partial tokens as "thinking…"
 * feedback so the user knows the agent is working (FR-MODEL-03 latency UX).
 */
let streamingBuffer = "";

function appendStreamingToken(token: string): void {
  streamingBuffer += token;
  // Show only first 120 chars of the streaming output to avoid UI clutter
  const preview = streamingBuffer.length > 120
    ? streamingBuffer.slice(0, 117) + "…"
    : streamingBuffer;
  transcriptBox.textContent = `🤔 Thinking: ${preview}`;
  transcriptBox.classList.remove("empty");
}

function clearStreamingBuffer(): void {
  streamingBuffer = "";
}

// ─── Vault Passphrase Prompt ─────────────────────────────────────────────────

/**
 * Show a passphrase input overlay so the user can unlock their vault.
 * Called when SW sends VAULT_PASSPHRASE_REQUEST (vault is locked during fill).
 */
function showVaultPassphrasePrompt(requestId: string): void {
  // Create overlay if not present
  let overlay = document.getElementById("vault-prompt-overlay");
  if (overlay) return; // Already showing

  overlay = document.createElement("div");
  overlay.id = "vault-prompt-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-labelledby", "vault-prompt-title");
  overlay.style.cssText = [
    "position:fixed", "inset:0", "background:rgba(0,0,0,.5)",
    "display:flex", "align-items:center", "justify-content:center", "z-index:9999",
  ].join(";");

  const box = document.createElement("div");
  box.style.cssText = [
    "background:var(--surface,#fff)", "border-radius:12px", "padding:24px",
    "width:260px", "box-shadow:0 8px 32px rgba(0,0,0,.2)",
  ].join(";");

  const title = document.createElement("h3");
  title.id = "vault-prompt-title";
  title.textContent = "🔐 Unlock Vault";
  title.style.cssText = "margin:0 0 8px;font-size:16px;";

  const desc = document.createElement("p");
  desc.textContent = "Enter your vault passphrase to auto-fill this field.";
  desc.style.cssText = "font-size:13px;color:var(--muted,#6b7280);margin:0 0 16px;";

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Passphrase";
  input.setAttribute("aria-label", "Vault passphrase");
  input.style.cssText = "width:100%;box-sizing:border-box;padding:8px;border:1px solid var(--border,#e5e7eb);border-radius:6px;font-size:14px;margin-bottom:12px;";

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  cancelBtn.type = "button";
  cancelBtn.style.cssText = "padding:8px 16px;border:1px solid var(--border,#e5e7eb);border-radius:6px;cursor:pointer;font-size:13px;";

  const submitBtn = document.createElement("button");
  submitBtn.textContent = "Unlock";
  submitBtn.type = "button";
  submitBtn.style.cssText = "padding:8px 16px;background:var(--accent,#6366f1);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;";

  const errorEl = document.createElement("p");
  errorEl.style.cssText = "color:#ef4444;font-size:12px;margin:8px 0 0;display:none;";
  errorEl.textContent = "Wrong passphrase — try again.";

  const handleSubmit = (): void => {
    const passphrase = input.value.trim();
    if (!passphrase) { input.focus(); return; }
    errorEl.style.display = "none";

    chrome.runtime.sendMessage({
      type: "VAULT_PASSPHRASE_RESPONSE",
      requestId,
      passphrase,
    }).catch(console.error);

    overlay?.remove();
  };

  submitBtn.addEventListener("click", handleSubmit);
  cancelBtn.addEventListener("click", () => overlay?.remove());
  input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") handleSubmit(); });

  // Listen for VAULT_UNLOCK_FAILED to show error
  const failListener = (rawMsg: unknown): boolean => {
    const m = rawMsg as { type?: string; requestId?: string };
    if (m.type === "VAULT_UNLOCK_FAILED" && m.requestId === requestId) {
      input.value = "";
      errorEl.style.display = "block";
      input.focus();
      chrome.runtime.onMessage.removeListener(failListener);
    }
    return false;
  };
  chrome.runtime.onMessage.addListener(failListener);

  btnRow.append(cancelBtn, submitBtn);
  box.append(title, desc, input, btnRow, errorEl);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  // Focus the passphrase input (a11y: dialog focus management)
  requestAnimationFrame(() => input.focus());
}

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

// ─── Live Audio Activity & Web Speech Engine ─────────────────────────────────

let currentListeningState = false;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let webSpeechRecognition: any = null;
let isWebSpeechRunning = false;

function updateAudioMeter(level: number, isSpeech: boolean): void {
  if (!audioMeterWrap || audioMeterWrap.style.display === "none") return;

  const active = isSpeech || level > 0.012;
  audioMeterStatus?.classList.toggle("speech", active);
  audioBars?.classList.toggle("speech", active);
  if (audioMeterText) {
    audioMeterText.textContent = active ? "Hearing speech..." : "Listening (mic active)";
  }

  // Dynamic bar visualization
  const scaled = Math.min(1, Math.max(0, level * 16));
  barSpans.forEach((bar, idx) => {
    const multiplier = [0.6, 1.0, 1.5, 1.9, 1.4, 0.9, 0.5][idx] ?? 1.0;
    const h = Math.max(3, Math.min(18, Math.round(scaled * 18 * multiplier)));
    bar.style.height = `${h}px`;
  });
}

function startWebSpeech(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.log("[Panel] Web Speech API not supported in this browser window.");
    return;
  }
  if (isWebSpeechRunning) return;

  try {
    webSpeechRecognition = new SpeechRecognition();
    webSpeechRecognition.continuous = true;
    webSpeechRecognition.interimResults = true;
    webSpeechRecognition.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webSpeechRecognition.onresult = (event: any) => {
      let interim = "";
      let final = "";
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final += event.results[i][0].transcript;
        } else {
          interim += event.results[i][0].transcript;
        }
      }

      const spoken = (final || interim).trim();
      if (spoken) {
        transcriptBox.textContent = spoken;
        transcriptBox.classList.remove("empty");
        updateAudioMeter(0.2, true);
      }

      if (final.trim()) {
        console.log(`[Panel WebSpeech] Final transcript: "${final.trim()}"`);
        chrome.runtime.sendMessage({
          type: "DIRECT_TRANSCRIPT",
          text: final.trim(),
        }).catch(console.error);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    webSpeechRecognition.onerror = (event: any) => {
      console.warn("[Panel WebSpeech] Notice:", event.error);
    };

    webSpeechRecognition.onend = () => {
      isWebSpeechRunning = false;
      // Auto-restart if listening is still enabled
      if (currentListeningState) {
        try {
          webSpeechRecognition.start();
          isWebSpeechRunning = true;
        } catch {
          // ignore restart collisions
        }
      }
    };

    webSpeechRecognition.start();
    isWebSpeechRunning = true;
    console.log("[Panel WebSpeech] Zero-latency speech engine started.");
  } catch (err: unknown) {
    console.warn("[Panel WebSpeech] Could not start speech recognition:", err);
  }
}

function stopWebSpeech(): void {
  if (webSpeechRecognition) {
    try {
      webSpeechRecognition.stop();
    } catch {}
    webSpeechRecognition = null;
  }
  isWebSpeechRunning = false;
}

/** Update the toggle button appearance. */
function updateToggleBtn(listening: boolean): void {
  currentListeningState = listening;
  toggleBtn.setAttribute("aria-pressed", String(listening));
  toggleBtn.classList.toggle("active", listening);
  toggleIcon.textContent = listening ? "⏹️" : "🎙️";
  toggleLabel.textContent = listening ? "Stop Listening" : "Start Listening";

  if (audioMeterWrap) {
    audioMeterWrap.style.display = listening ? "flex" : "none";
  }

  if (listening) {
    startWebSpeech();
  } else {
    stopWebSpeech();
    barSpans.forEach((bar) => { bar.style.height = "4px"; });
  }
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
    li.textContent = describeAction(action as unknown as Record<string, unknown> & { type: string });
    planActionsEl.appendChild(li);
  }

  // Confirmation buttons for R3/R4
  const needsConfirm = plan.requiresConfirmation;
  confirmBtns.hidden = !needsConfirm;

  // WCAG 2.2 — move focus to the Cancel button when a confirmation dialog appears
  // (the safer default: user must actively press Enter/Confirm, not just Enter accidentally)
  if (needsConfirm) {
    requestAnimationFrame(() => btnCancel.focus());
  }
}

/** Hide the plan section and clear state. */
function hidePlan(): void {
  currentPlan = null;
  planSection.hidden = true;
  confirmBtns.hidden = true;
}

/** Add an entry to the history list from a plan. */
function addHistory(plan: AgentPlan): void {
  historyEmpty.hidden = true;
  renderHistoryItem(plan.intent, plan.risk <= RiskTier.R2);
}

/**
 * Render a history list item.
 * @param intent  - Human-readable intent/command string.
 * @param undoable - Whether to show the Undo button (R0-R2 only).
 */
function renderHistoryItem(intent: string, undoable: boolean): void {
  const item = document.createElement("div");
  item.className = "history-item";
  item.setAttribute("role", "listitem");

  const textEl = document.createElement("div");
  textEl.className = "history-item-text";
  const strong = document.createElement("strong");
  strong.textContent = intent.slice(0, 80);
  textEl.appendChild(strong);

  item.appendChild(textEl);

  if (undoable) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "btn-undo";
    undoBtn.textContent = "Undo";
    undoBtn.type = "button";
    undoBtn.setAttribute("aria-label", `Undo: ${intent}`);
    undoBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "UNDO_LAST_ACTION" }).catch(console.error);
      item.remove();
      if (historyList.querySelectorAll(".history-item").length === 0) {
        historyEmpty.hidden = false;
      }
    });
    item.appendChild(undoBtn);
  }

  // Prepend newest first
  historyList.insertBefore(item, historyList.firstChild);

  // Cap at 20 entries in the panel (full list is in persistent storage)
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
    case "AUDIO_LEVEL": {
      updateAudioMeter(msg.level, msg.isSpeech);
      break;
    }

    case "SESSION_STATE_UPDATE": {
      const state = msg.state as SessionState;
      updateStatus(state.agentState);
      updateToggleBtn(state.listeningEnabled);
      if (!state.currentPlan) hidePlan();
      break;
    }

    case "TRANSCRIPT_UPDATE": {
      clearStreamingBuffer();
      transcriptBox.textContent = msg.text;
      transcriptBox.classList.toggle("empty", !msg.text);
      break;
    }

    case "PLAN_READY": {
      clearStreamingBuffer();
      showPlan(msg.plan);
      break;
    }

    case "AGENT_STATE_CHANGED": {
      updateStatus(msg.state, msg.error);
      if (msg.state === AgentState.Listening || msg.state === AgentState.Idle) {
        clearStreamingBuffer();
        hidePlan();
      }
      break;
    }

    case "MODEL_LOAD_PROGRESS": {
      // Show model download progress bar (FR-MODEL-01).
      let pct = 0;
      let phase = "Loading speech model";

      if (msg.stt && msg.stt.total > 0 && msg.stt.loaded < msg.stt.total) {
        pct = Math.round((msg.stt.loaded / msg.stt.total) * 100);
        phase = "Downloading speech model";
      } else if (msg.llm && msg.llm.total > 0 && msg.llm.loaded < msg.llm.total) {
        pct = Math.round((msg.llm.loaded / msg.llm.total) * 100);
        phase = "Downloading AI planner";
      } else if (msg.stt && msg.stt.total > 0) {
        pct = 100;
        phase = "Speech ready";
      }

      const done = pct >= 100 && (!msg.llm || msg.llm.loaded >= msg.llm.total);
      showModelProgress(pct, phase, done);
      break;
    }

    case "LLM_TOKEN": {
      // Show streaming LLM tokens as "thinking" feedback (FR-MODEL-03)
      appendStreamingToken(msg.delta);
      break;
    }

    case "VAULT_PASSPHRASE_REQUEST": {
      // Vault is locked — prompt user for passphrase (FR-VAULT-04)
      showVaultPassphrasePrompt(msg.requestId);
      break;
    }

    case "EXECUTION_DONE": {
      clearStreamingBuffer();
      if (currentPlan) {
        addHistory(currentPlan);
        hidePlan();
      }
      break;
    }
  }
});

// ─── Button Handlers ──────────────────────────────────────────────────────────

toggleBtn.addEventListener("click", async () => {
  // Chrome MV3 requirement: request microphone permission from a visible page first
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch (err: unknown) {
    console.warn("[Panel] Microphone permission prompt was denied or dismissed:", err);
  }
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

// ─── Audit Log: Populate History on Panel Open ───────────────────────────────

/**
 * Load the persistent audit log from SW and populate the history panel.
 * Called once at init. The panel session also tracks in-session history
 * via EXECUTION_DONE messages.
 */
async function loadAuditLog(): Promise<void> {
  try {
    const entries = await chrome.runtime.sendMessage({
      type: "GET_AUDIT_LOG",
      limit: 20,
    }) as Array<{ intent: string; risk: number }>;

    if (!Array.isArray(entries) || entries.length === 0) return;

    historyEmpty.hidden = true;
    for (const entry of entries) {
      renderHistoryItem(entry.intent ?? "(unknown)", (entry.risk ?? 4) <= RiskTier.R2);
    }
  } catch {
    // History unavailable — that's fine
  }
}

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

  await loadAuditLog();
}

init().catch(console.error);

