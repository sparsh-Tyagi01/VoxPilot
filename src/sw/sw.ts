/**
 * @file src/sw/sw.ts
 * @description VoxPilot Service Worker — the central orchestrator.
 *
 * Architecture constraints (MV3 Service Worker rules):
 * - ZERO module-level mutable state. The SW can be killed and restarted at any time.
 *   ALL state is persisted in chrome.storage.session and re-read on each event.
 * - Async chrome.* API calls are always awaited inside event handlers.
 * - Long-lived listeners (onMessage, onCommand, onAlarm) are registered synchronously
 *   at the top level, not inside async callbacks.
 * - `return true` is used in onMessage when the response is sent asynchronously.
 *
 * Responsibilities:
 * 1. Manage the offscreen document lifecycle (create, keepalive, teardown)
 * 2. Relay messages between offscreen ↔ content scripts ↔ panel
 * 3. Handle keyboard shortcut (Alt+V)
 * 4. Store/restore session state from chrome.storage.session
 * 5. Manage chrome.alarms for SW keepalive
 */

import {
  SW_KEEPALIVE_ALARM,
  SW_KEEPALIVE_ALARM_PERIOD_MINUTES,
  SESSION_KEYS,
  CONTENT_SCRIPT_TIMEOUT_MS,
} from "@shared/constants.js";
import type { ModelLoadProgressMsg, VoxPilotMessage } from "@shared/messages.js";
import { normalizeModelProfile } from "@shared/model-profiles.js";
import { authorizedSender } from "./message-policy.js";
import { PerformanceMetrics } from "../diagnostics/metrics.js";
import { AgentState } from "@shared/types.js";
import type { SessionState, AgentPlan } from "@shared/types.js";
import { loadMacros, saveMacros, generateMacroId, deriveTriggerWords } from "@shared/macros.js";
import { appendHistory, clearHistory, loadHistory, generateHistoryId } from "@shared/history.js";
import { VaultService } from "@vault/vault.js";
import { PlanValidator } from "../offscreen/agent/plan-validator.js";
import { RiskClassifier } from "../offscreen/agent/risk-classifier.js";
import { executeBrowserPlan } from "./plan-execution.js";
import { ExecutionJournal } from "./execution-journal.js";
import { groundMacroActions } from "./macro-grounding.js";

// In-flight locks serialize events; durable state remains in storage.session.
const metrics = new PerformanceMetrics();
// In-memory only: termination of this service worker locks the vault automatically.
const vaultSession = new VaultService();
let vaultLockVersion = 0;
const journal = new ExecutionJournal();
let recovery: Promise<void> | null = null;
let sessionWrite: Promise<unknown> = Promise.resolve();
let listeningOperation: Promise<void> = Promise.resolve();
let offscreenCreation: Promise<void> | null = null;
const MODEL_STATUS_KEY = "model_load_status";
const canonicalProfile = normalizeModelProfile;

// ─── Default Session State ────────────────────────────────────────────────────

function defaultSessionState(): SessionState {
  return {
    agentState: AgentState.Idle,
    activeTabId: null,
    lastTranscript: "",
    currentPlan: null,
    offscreenActive: false,
    listeningEnabled: false,
    lastKeepalive: Date.now(),
    errorCount: 0,
  };
}

// ─── Session State Helpers ────────────────────────────────────────────────────

/**
 * Read the current session state from chrome.storage.session.
 * Returns default state if none exists (first run after SW restart).
 */
async function getSessionState(): Promise<SessionState> {
  const result = await chrome.storage.session.get(SESSION_KEYS.SESSION_STATE);
  return (result[SESSION_KEYS.SESSION_STATE] as SessionState | undefined) ?? defaultSessionState();
}

/**
 * Persist the session state to chrome.storage.session.
 * Also broadcasts the new state to any open panel connections.
 */
async function setSessionState(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEYS.SESSION_STATE]: state });
  // Broadcast to popup (best-effort; panel may not be open)
  broadcastToPanel({ type: "SESSION_STATE_UPDATE", state });
}

/**
 * Partial update helper — reads, merges, writes.
 */
async function updateSessionState(
  partial: Partial<SessionState> | ((current: SessionState) => Partial<SessionState>)
): Promise<SessionState> {
  const write = sessionWrite.then(async () => {
    const current = await getSessionState();
    const next = { ...current, ...(typeof partial === "function" ? partial(current) : partial) };
    await setSessionState(next);
    return next;
  });
  sessionWrite = write.catch(() => {});
  return write;
}

// ─── Panel Broadcast ──────────────────────────────────────────────────────────

/**
 * Best-effort broadcast to the popup.
 * Swallows "Could not establish connection" errors (panel not open).
 */
function broadcastToPanel(msg: VoxPilotMessage): void {
  chrome.runtime.sendMessage({ ...msg, target: "ui" }).catch(() => {
    // Panel is not open — this is expected and not an error
  });
}

/**
 * Send a message to the offscreen document.
 * The offscreen doc receives all chrome.runtime messages (it has no other comms path).
 */
async function relayToOffscreen(msg: VoxPilotMessage): Promise<void> {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
  if (response?.ok === false) throw new Error(response.error ?? `Offscreen ${msg.type} failed`);
}

function isInternalUrl(url?: string): boolean {
  if (!url) return false;
  return (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:") ||
    url.startsWith("devtools://")
  );
}

async function getTargetTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

/** On worker restart, interrupt unfinished work. Side effects are never replayed. */
function recoverInterruptedExecution(): Promise<void> {
  recovery ??= (async () => {
    const interruptedId = await journal.recover();
    const state = await getSessionState();
    if (state.agentState !== AgentState.Executing || !state.currentPlan) return;
    if (interruptedId && state.executionId !== interruptedId) return;
    await updateSessionState({ currentPlan: null, executionId: null, currentDocumentId: null, agentState: state.listeningEnabled ? AgentState.Listening : AgentState.Idle });
    broadcastToPanel({ type: "COMMAND_NOTICE", text: "The previous command was interrupted. Check the page before repeating it." });
    if (await hasOffscreenDocument()) await relayToOffscreen({ type: "EXECUTION_DONE", success: false });
  })();
  return recovery;
}

async function completePlan(tabId: number, plan: AgentPlan): Promise<void> {
  await updateSessionState({ agentState: AgentState.Executing });
  const actionStarted = performance.now();
  const executionState = await getSessionState();
  const executionId = executionState.executionId!;
  try {
    await journal.begin(executionId);
    await relayToOffscreen({ type: "AGENT_STATE_CHANGED", state: AgentState.Executing });
    await executeBrowserPlan(tabId, plan, sendToContentScript, async () => {
      const state = await getSessionState();
      return state.listeningEnabled && state.executionId === executionId && state.agentState === AgentState.Executing;
    }, executionState.currentDocumentId ?? undefined, (index, kind, status) => journal.step(executionId, index, kind, status));
    await journal.finish(executionId, true);
    metrics.add({ stage: "action_execution", durationMs: performance.now() - actionStarted, success: true });
    const done = plan.actions.find(action => action.type === "done");
    const question = plan.actions.find(action => action.type === "ask");
    const speech = question?.question ?? done?.summary;
    const { voice_settings } = await chrome.storage.local.get("voice_settings");
    if (speech && (question || voice_settings?.spokenConfirmations === true) && !plan.actions.some(action => action.type === "read")) {
      void relayToOffscreen({ type: "SPEAK", text: speech }).catch(error => console.warn("[SW] Feedback failed:", error));
    }
    await appendHistory({
      id: generateHistoryId(), timestamp: new Date().toISOString(),
      transcript: (await getSessionState()).lastTranscript, plan, success: true,
    }).catch(() => {});
    const state = await getSessionState();
    await updateSessionState({ agentState: state.listeningEnabled ? AgentState.Listening : AgentState.Idle, currentPlan: null, executionId: null });
    broadcastToPanel({ type: "EXECUTION_DONE", success: true });
    await relayToOffscreen({ type: "EXECUTION_DONE", success: true });
  } catch (error) {
    metrics.add({ stage: "action_execution", durationMs: performance.now() - actionStarted, success: false });
    await journal.finish(executionId, false);
    const state = await getSessionState();
    if (String(error).includes("Command cancelled.")) {
      broadcastToPanel({ type: "EXECUTION_DONE", success: false });
      await relayToOffscreen({ type: "EXECUTION_DONE", success: false });
      return;
    }
    await updateSessionState({ agentState: state.listeningEnabled ? AgentState.Error : AgentState.Idle, currentPlan: null, executionId: null });
    await relayToOffscreen({ type: "EXECUTION_DONE", success: false, error: String(error) });
    throw error;
  }
}

/**
 * Dispatch an AgentPlan to the appropriate tab or overlay.
 */
async function dispatchPlan(plan: AgentPlan, documentId?: string): Promise<boolean> {
  new PlanValidator().validate(plan);
  const previous = await getSessionState();
  const targetTabId = previous.activeTabId ?? (await getTargetTab())?.id;
  if (targetTabId === undefined || targetTabId === null) throw new Error("Open a regular webpage before issuing a command.");
  const risk = new RiskClassifier().classify(plan);
  plan = { ...plan, risk, requiresConfirmation: plan.requiresConfirmation || risk >= 3 };
  await updateSessionState({
    currentPlan: plan, currentDocumentId: documentId ?? null, activeTabId: targetTabId, executionId: crypto.randomUUID(),
    agentState: plan.requiresConfirmation ? AgentState.Confirming : AgentState.Executing,
  });
  broadcastToPanel({ type: "PLAN_READY", plan });
  if (plan.requiresConfirmation) {
    await sendToContentScript(targetTabId, { type: "SHOW_CONFIRMATION", plan }).catch(() => {
      // The toolbar popup remains an alternative confirmation surface.
    });
    await chrome.action.setBadgeText({ text: "?" });
    await chrome.action.setTitle({ title: "VoxPilot — confirmation needed. Open the popup." });
  } else {
    await completePlan(targetTabId, plan);
  }
  return true;
}

// ─── Offscreen Document Lifecycle ─────────────────────────────────────────────

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [
  (chrome.offscreen?.Reason?.USER_MEDIA ?? "USER_MEDIA") as chrome.offscreen.Reason,
  (chrome.offscreen?.Reason?.WORKERS ?? "WORKERS") as chrome.offscreen.Reason,
];

/**
 * Check whether the offscreen document is currently open.
 */
async function hasOffscreenDocument(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (chrome as any).offscreen?.hasDocument === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (chrome as any).offscreen.hasDocument();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getContexts = (chrome.runtime as any).getContexts as ((q: unknown) => Promise<unknown[]>) | undefined;
  if (getContexts) {
    const contexts = await getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return contexts.length > 0;
  }
  return false;
}

/**
 * Ensure the offscreen document is open.
 * Uses the chrome.offscreen API (MV3).
 * Safe to call multiple times — only creates if not already open.
 */
async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenCreation) return offscreenCreation;
  offscreenCreation = createOffscreenDocument();
  try { await offscreenCreation; } finally { offscreenCreation = null; }
}

async function createOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    await updateSessionState({ offscreenActive: true, lastKeepalive: Date.now() });
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: OFFSCREEN_REASONS,
      justification:
        "VoxPilot requires persistent AudioContext for real-time microphone capture and on-device ONNX Runtime Web inference (STT + LLM). This cannot be done in the service worker.",
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("Only a single offscreen document may be created")) {
      console.error("[SW] Failed to create offscreen document:", err);
      throw err;
    }
  }

  await updateSessionState({ offscreenActive: true, lastKeepalive: Date.now() });
  console.log("[SW] Offscreen document created.");
}

// ─── Message Relay: SW → Content Script ──────────────────────────────────────

/**
 * Send a message to the content script in a specific tab.
 * @throws if the content script doesn't respond within CONTENT_SCRIPT_TIMEOUT_MS.
 */
async function sendToContentScript(
  tabId: number,
  msg: VoxPilotMessage
): Promise<VoxPilotMessage | null> {
  const trySend = (): Promise<VoxPilotMessage | null> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Content script in tab ${tabId} did not respond within ${CONTENT_SCRIPT_TIMEOUT_MS}ms`));
      }, CONTENT_SCRIPT_TIMEOUT_MS);

      chrome.tabs.sendMessage(tabId, msg, { frameId: 0 }, (response: VoxPilotMessage | null) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  };

  try {
    return await trySend();
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("Receiving end does not exist") || errorMsg.includes("Could not establish connection")) {
      // Content script not yet injected into this tab (e.g., opened before extension reload)
      const manifest = chrome.runtime.getManifest();
      const files = manifest.content_scripts?.[0]?.js;
      if (files && files.length > 0) {
        try {
          console.log(`[SW] On-demand injecting content script into tab ${tabId}...`);
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files,
          });
          // Allow content script a brief tick to mount its onMessage listener
          await new Promise((r) => setTimeout(r, 150));
          return await trySend();
        } catch (injectErr: unknown) {
          console.warn("[SW] Dynamic script injection skipped or failed:", injectErr);
        }
      }
    }
    throw err;
  }
}

// ─── Listening Toggle ─────────────────────────────────────────────────────────

/**
 * Toggle the listening state.
 * Keeps models resident while toggling microphone capture.
 */
async function toggleListening(): Promise<void> {
  await recoverInterruptedExecution();
  const next = listeningOperation.then(toggleListeningNow);
  listeningOperation = next.catch(() => {});
  return next;
}

async function updateBadge(listening: boolean): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: listening ? "#14815D" : "#536075" });
  await chrome.action.setBadgeText({ text: listening ? "ON" : "" });
  await chrome.action.setTitle({ title: listening ? "VoxPilot — microphone on (Alt+V to pause)" : "VoxPilot — microphone paused" });
}

async function toggleListeningNow(): Promise<void> {
  const state = await getSessionState();
  if (state.listeningEnabled) {
    await relayToOffscreen({ type: "STOP_AUDIO" });
    await updateSessionState({ listeningEnabled: false, agentState: AgentState.Idle, currentPlan: null, executionId: null });
    await updateBadge(false);
  } else {
    const tab = await getTargetTab();
    const { selected_profile } = await chrome.storage.local.get("selected_profile");
    const profile = typeof selected_profile === "string" ? selected_profile : "essential";
    await ensureOffscreenDocument();
    // Persist intent first so readiness events do not overwrite an active mic state.
    await updateSessionState({ activeTabId: tab?.id ?? null, listeningEnabled: true, agentState: AgentState.Idle });
    try {
      await relayToOffscreen({ type: "START_AUDIO", profile });
      await updateSessionState({ listeningEnabled: true, agentState: AgentState.Listening });
      await updateBadge(true);
    } catch (error) {
      await updateSessionState({ listeningEnabled: false, agentState: AgentState.Error });
      await updateBadge(false);
      throw error;
    }
  }
}

async function prepareModelStatus(profile: string): Promise<void> {
  const saved = await chrome.storage.session.get(MODEL_STATUS_KEY);
  const status = saved[MODEL_STATUS_KEY] as ModelLoadProgressMsg | undefined;
  if (!await hasOffscreenDocument() || status?.profile !== canonicalProfile(profile) || status?.phase === "error") {
    const next: ModelLoadProgressMsg = { type: "MODEL_LOAD_PROGRESS", profile: canonicalProfile(profile), progress: 0, phase: "loading", done: false, text: "Preparing on-device models…" };
    await chrome.storage.session.set({ [MODEL_STATUS_KEY]: next });
    broadcastToPanel(next);
  }
}

// ─── Message Router ───────────────────────────────────────────────────────────

/**
 * Central message handler for all chrome.runtime.onMessage events.
 * Returns `true` to indicate async response where needed.
 */
chrome.runtime.onMessage.addListener(
  (
    rawMsg: unknown,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response?: unknown) => void
  ): boolean => {
    const msg = rawMsg as VoxPilotMessage;
    if (!msg || typeof msg.type !== "string" || msg.target === "offscreen" || msg.target === "ui") return false;

    if (!authorizedSender(msg.type, sender, chrome.runtime.id)) {
      sendResponse({ ok: false, error: "This context cannot issue that command." });
      return false;
    }

    // Run async handler and plumb errors to console
    handleMessage(msg, sender, sendResponse).catch(async (err: unknown) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error("[SW] Message handler error:", err);
      sendResponse({ ok: false, error });
      await updateSessionState({ agentState: AgentState.Error });
      broadcastToPanel({ type: "AGENT_STATE_CHANGED", state: AgentState.Error, error });
    });

    // Return true to keep the message channel open for async sendResponse
    return true;
  }
);

async function handleMessage(
  msg: VoxPilotMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
): Promise<void> {
  await recoverInterruptedExecution();
  switch (msg.type) {
    // ── Panel → SW ─────────────────────────────────────────────────────────
    case "TOGGLE_LISTENING": {
      await toggleListening();
      sendResponse({ ok: true });
      break;
    }

    case "GET_SESSION_STATE": {
      let state = await getSessionState();
      if (state.offscreenActive && !await hasOffscreenDocument()) {
        state = await updateSessionState({ offscreenActive: false, listeningEnabled: false, agentState: AgentState.Idle });
        await updateBadge(false);
      }
      sendResponse(state);
      break;
    }

    case "PERFORMANCE_SAMPLE": {
      if (msg.sample && typeof msg.sample === "object") metrics.add(msg.sample);
      sendResponse({ ok: true });
      break;
    }
    case "COMMAND_NOTICE": {
      broadcastToPanel(msg);
      sendResponse({ ok: true });
      break;
    }
    case "GET_DIAGNOSTICS": {
      sendResponse({ ...metrics.snapshot(), execution: await journal.read() });
      break;
    }
    case "GET_MODEL_STATUS": {
      const saved = await chrome.storage.session.get(MODEL_STATUS_KEY);
      const status = saved[MODEL_STATUS_KEY] as ModelLoadProgressMsg | undefined;
      sendResponse(await hasOffscreenDocument() ? status ?? { type: "MODEL_LOAD_PROGRESS", phase: "idle", done: false } : { type: "MODEL_LOAD_PROGRESS", phase: "idle", done: false, text: "Models load from your device when listening starts." });
      break;
    }

    case "CONFIRM_PLAN": {
      let state: SessionState;
      try {
        state = await updateSessionState(current => {
          if (!current.currentPlan || current.activeTabId === null || current.agentState !== AgentState.Confirming) throw new Error("There is no plan awaiting confirmation.");
          return { agentState: AgentState.Executing };
        });
      } catch (error) {
        sendResponse({ ok: false, error: String(error) });
        break;
      }
      await sendToContentScript(state.activeTabId!, { type: "HIDE_CONFIRMATION" }).catch(() => {});
      await updateBadge(state.listeningEnabled);
      await completePlan(state.activeTabId!, state.currentPlan!);
      sendResponse({ ok: true });
      break;
    }

    case "CANCEL_PLAN": {
      const state = await getSessionState();
      if (state.activeTabId !== null) await sendToContentScript(state.activeTabId, { type: "HIDE_CONFIRMATION" }).catch(() => {});
      await relayToOffscreen({ type: "EXECUTE_TEXT_COMMAND", text: "stop" });
      await updateSessionState({ agentState: state.listeningEnabled ? AgentState.Listening : AgentState.Idle, currentPlan: null, executionId: null });
      await updateBadge(state.listeningEnabled);
      sendResponse({ ok: true });
      break;
    }

    case "UNDO_LAST_ACTION": {
      // Reversible actions (R0-R2) are popped and inverted in offscreen undo stack (FR-SAFE-03)
      await relayToOffscreen({ type: "UNDO_LAST_ACTION" });
      sendResponse({ ok: true });
      break;
    }

    case "TRIGGER_MACRO": {
      const macros = await loadMacros();
      const macro = macros.find(m => m.id === msg.macroId);
      if (!macro) {
        sendResponse({ ok: false, error: `Macro "${msg.macroId}" not found` });
        break;
      }
      const macroState = await getSessionState();
      if (!macroState.listeningEnabled || macroState.currentPlan) throw new Error("Start listening and finish the current command before running a macro.");
      const target = await getTargetTab();
      if (target?.id === undefined) throw new Error("Open the macro's webpage first.");
      if (macro.recordedOnUrl && (!target.url || new URL(macro.recordedOnUrl).origin !== new URL(target.url).origin)) throw new Error("Open the website where this macro was recorded.");
      let actions = macro.actions;
      let documentId: string | undefined;
      if (actions.some(action => "handle" in action && action.handle)) {
        const response = await sendToContentScript(target.id, { type: "CAPTURE_SNAPSHOT", includeText: false });
        if (response?.type !== "SNAPSHOT_RESPONSE") throw new Error("The page could not provide fresh macro targets.");
        actions = groundMacroActions(actions, response.snapshot);
        documentId = response.snapshot.documentId;
      }
      await updateSessionState({ activeTabId: target.id });
      await dispatchPlan({ intent: `Run macro: ${macro.name}`, risk: 1, requiresConfirmation: false, actions }, documentId);
      macro.useCount++;
      await saveMacros(macros);
      sendResponse({ ok: true });
      break;
    }

    // ── Panel / Direct Speech → SW ──────────────────────────────────────────
    case "DIRECT_TRANSCRIPT": {
      const text = msg.text.trim();
      const state = await getSessionState();
      if (!state.listeningEnabled) throw new Error("Start listening before sending a command.");
      if (text) {
        const target = await getTargetTab();
        await updateSessionState({ lastTranscript: text, activeTabId: target?.id ?? state.activeTabId });
        await relayToOffscreen({ type: "EXECUTE_TEXT_COMMAND", text });
      }
      sendResponse({ ok: true });
      break;
    }

    // ── Offscreen → SW ─────────────────────────────────────────────────────
    case "AUDIO_LEVEL": {
      // Forward real-time microphone level to panel for VU meter
      broadcastToPanel(msg);
      sendResponse({ ok: true });
      break;
    }

    case "TRANSCRIPT": {
      const tab = msg.isFinal ? await getTargetTab() : null;
      await updateSessionState({
        ...(tab?.id !== undefined ? { activeTabId: tab.id } : {}),
        lastTranscript: msg.text,
        agentState: msg.isFinal ? AgentState.Routing : AgentState.Transcribing,
      });
      // Forward to panel for live display
      broadcastToPanel({ type: "TRANSCRIPT_UPDATE", text: msg.text, isFinal: msg.isFinal });
      sendResponse({ ok: true });
      break;
    }

    case "PLAN_PRODUCED": {
      await dispatchPlan(msg.plan, msg.documentId);
      sendResponse({ ok: true });
      break;
    }

    case "REQUEST_SNAPSHOT": {
      const tab = await getTargetTab();
      const tabId = msg.tabId > 0 ? msg.tabId : tab?.id;
      if (tabId === undefined || isInternalUrl(tab?.url)) throw new Error("Open a regular webpage to use page commands.");
      const response = await sendToContentScript(tabId, { type: "CAPTURE_SNAPSHOT", ...(msg.includeText !== undefined ? { includeText: msg.includeText } : {}) });
      if (response?.type !== "SNAPSHOT_RESPONSE") throw new Error("Could not read this page. Refresh it and try again.");
      await updateSessionState({ activeTabId: tabId });
      await relayToOffscreen({ type: "PAGE_SNAPSHOT", snapshot: response.snapshot });
      sendResponse({ ok: true });
      break;
    }

    case "OFFSCREEN_ERROR": {
      if (msg.source === "tts") {
        console.warn("[SW] Spoken feedback unavailable; command state preserved.");
        sendResponse({ ok: true });
        break;
      }
      console.error(`[SW] Offscreen error (${msg.source}): ${msg.message}`);
      const { errorCount } = await getSessionState();
      await updateSessionState({
        agentState: AgentState.Error,
        errorCount: errorCount + 1,
      });
      broadcastToPanel({
        type: "AGENT_STATE_CHANGED",
        state: AgentState.Error,
        error: msg.message,
      });
      sendResponse({ ok: true });
      break;
    }

    case "TTS_DONE": {
      // Completion of speech must not overwrite a newer transcription/planning state.
      sendResponse({ ok: true });
      break;
    }

    case "RELAY_ACTION": {
      // Relay plan execution to content script
      try {
        await sendToContentScript(msg.tabId, {
          type: "EXECUTE_IN_PAGE",
          plan: msg.plan,
        });
      } catch (err: unknown) {
        console.error("[SW] Relay action failed:", err);
      }
      sendResponse({ ok: true });
      break;
    }

    // ── Content Script → SW ────────────────────────────────────────────────
    case "EXECUTION_DONE": {
      const doneState = await getSessionState();
      // Record to history (opt-in)
      await appendHistory({
        id: generateHistoryId(),
        timestamp: new Date().toISOString(),
        transcript: doneState.lastTranscript,
        plan: doneState.currentPlan,
        success: msg.success,
        ...(msg.error !== undefined ? { error: msg.error } : {}),
      }).catch(() => {}); // history write failure is non-fatal

      if (msg.success) {
        await updateSessionState({ agentState: AgentState.Listening, currentPlan: null });
      } else {
        const { errorCount } = await getSessionState();
        await updateSessionState({
          agentState: AgentState.Error,
          errorCount: errorCount + 1,
        });
      }

      // Relay EXECUTION_DONE to offscreen so AgentCore transitions back to Listening
      broadcastToPanel({ type: "EXECUTION_DONE" as any, success: msg.success } as any);
      await relayToOffscreen({ type: "EXECUTION_DONE" as any, success: msg.success } as any);

      sendResponse({ ok: true });
      break;
    }

    case "SNAPSHOT_RESPONSE": {
      // Forward to offscreen for LLM planning
      await chrome.runtime.sendMessage({
        type: "PAGE_SNAPSHOT",
        snapshot: msg.snapshot,
      }).catch(() => {});
      sendResponse({ ok: true });
      break;
    }

    case "IN_PAGE_CONFIRM": {
      const current = await getSessionState();
      if (sender.tab?.id !== current.activeTabId || (sender.frameId ?? 0) !== 0) {
        sendResponse({ ok: false, error: "Confirmation came from a different page." });
        break;
      }
      if (msg.confirmed) {
        await handleMessage({ type: "CONFIRM_PLAN" }, sender, sendResponse);
      } else {
        await handleMessage({ type: "CANCEL_PLAN" }, sender, sendResponse);
      }
      break;
    }

    case "SAVE_MACRO": {
      const macros = await loadMacros();
      if (macros.length >= 50) {
        sendResponse({ ok: false, error: "Maximum 50 macros reached" });
        break;
      }
      const recordedOnUrl = (await getTargetTab())?.url;
      const newMacro = {
        id: generateMacroId(),
        name: msg.name,
        triggerWords: deriveTriggerWords(msg.name),
        actions: msg.actions,
        createdAt: new Date().toISOString(),
        useCount: 0,
        ...(recordedOnUrl ? { recordedOnUrl } : {}),
      };
      macros.push(newMacro);
      await saveMacros(macros);
      sendResponse({ ok: true, macro: newMacro });
      break;
    }

    case "DELETE_MACRO": {
      const macros = await loadMacros();
      const updated = macros.filter(m => m.id !== msg.macroId);
      await saveMacros(updated);
      sendResponse({ ok: true });
      break;
    }

    case "GET_MACROS": {
      const macros = await loadMacros();
      sendResponse({ ok: true, macros });
      break;
    }

    case "CLEAR_HISTORY": {
      await clearHistory();
      sendResponse({ ok: true });
      break;
    }

    case "AGENT_STATE_CHANGED": {
      const state = await getSessionState();
      const nextState = !state.listeningEnabled && msg.state === AgentState.Listening ? AgentState.Idle : msg.state;
      await updateSessionState({ agentState: nextState,
        ...([AgentState.Listening, AgentState.Idle].includes(nextState) && [AgentState.Executing, AgentState.Confirming].includes(state.agentState) ? { currentPlan: null, executionId: null } : {}),
      });
      broadcastToPanel({ ...msg, state: nextState });
      sendResponse({ ok: true });
      break;
    }

    case "MODEL_LOAD_PROGRESS": {
      await chrome.storage.session.set({ [MODEL_STATUS_KEY]: msg });
      if (msg.done) await chrome.storage.local.set({ models_cached_profile: msg.profile });
      broadcastToPanel(msg);
      sendResponse({ ok: true });
      break;
    }

    case "LLM_TOKEN": {
      // Forward streaming token to panel
      broadcastToPanel(msg);
      sendResponse({ ok: true });
      break;
    }

    case "GET_AUDIT_LOG": {
      const entries = await loadHistory();
      sendResponse(entries.slice(0, msg.limit ?? 50));
      break;
    }

    // ─── Vault Fill (FR-VAULT-04) ─────────────────────────────────────────────

    case "VAULT_LOCK": {
      vaultLockVersion++;
      vaultSession.lock();
      sendResponse({ ok: true });
      break;
    }
    case "VAULT_FILL_REQUEST": {
      // Security contract: Only the SW can access vault values.
      // The decrypted value is sent directly to the requesting tab's content
      // script — it never passes through offscreen or the LLM.

      // Determine which tab this message came from (required for sendMessage)
      const senderTabId = sender?.tab?.id;
      if (senderTabId === undefined) {
        sendResponse({ ok: false, error: "No tab ID in VAULT_FILL_REQUEST sender" });
        break;
      }
      const vaultExecution = await getSessionState();
      const lockVersion = vaultLockVersion;
      if (vaultExecution.agentState !== AgentState.Executing || vaultExecution.activeTabId !== senderTabId || !vaultExecution.currentPlan?.actions.some(action => action.type === "fill_from_vault" && action.handle === msg.handle && action.vaultField === msg.fieldKey)) throw new Error("Vault fill is not part of the approved command.");

      // Reuse a short-lived memory session; worker termination drops the key.
      const vaultSvc = vaultSession;

      // If the vault is locked, we need the user's passphrase.
      // We'll prompt via the panel (broadcast VAULT_PASSPHRASE_REQUEST),
      // then wait for the user's VAULT_PASSPHRASE_RESPONSE.
      if (!vaultSvc.isUnlocked) {
        const requestId = crypto.randomUUID();

        // Ask the panel to show a passphrase prompt
        broadcastToPanel({ type: "VAULT_PASSPHRASE_REQUEST", requestId });

        // Wait for the user's passphrase (or timeout after 60s)
        const passphrase = await new Promise<string | null>((resolve) => {
          const timer = setTimeout(() => {
            chrome.runtime.onMessage.removeListener(listener);
            resolve(null); // Timed out
          }, 60_000);

          const listener = (
            passphraseMsg: unknown,
            _passphraseSource: chrome.runtime.MessageSender,
            _respond: (response?: unknown) => void
          ): boolean => {
            if (
              _passphraseSource.id === chrome.runtime.id &&
              _passphraseSource.url?.startsWith(chrome.runtime.getURL("")) &&
              typeof passphraseMsg === "object" &&
              passphraseMsg !== null &&
              (passphraseMsg as { type?: string }).type === "VAULT_PASSPHRASE_RESPONSE" &&
              (passphraseMsg as { requestId?: string }).requestId === requestId
            ) {
              clearTimeout(timer);
              chrome.runtime.onMessage.removeListener(listener);
              resolve((passphraseMsg as { passphrase: string }).passphrase);
            }
            return false;
          };

          chrome.runtime.onMessage.addListener(listener);
        });

        if (!passphrase) {
          // Passphrase prompt was dismissed or timed out
          chrome.tabs.sendMessage(senderTabId, {
            type: "VAULT_FILL_ERROR",
            handle: msg.handle,
            error: "Vault passphrase not provided",
          }).catch(() => {});
          sendResponse({ ok: false, error: "Vault passphrase not provided" });
          break;
        }

        if (lockVersion !== vaultLockVersion) throw new Error("Vault locked while waiting for the passphrase.");
        const unlocked = await vaultSvc.unlock(passphrase);
        if (!unlocked) {
          broadcastToPanel({ type: "VAULT_UNLOCK_FAILED", requestId });
          chrome.tabs.sendMessage(senderTabId, {
            type: "VAULT_FILL_ERROR",
            handle: msg.handle,
            error: "Incorrect vault passphrase",
          }).catch(() => {});
          sendResponse({ ok: false, error: "Incorrect vault passphrase" });
          break;
        }
      }

      const currentVaultExecution = await getSessionState();
      if (lockVersion !== vaultLockVersion || currentVaultExecution.executionId !== vaultExecution.executionId || currentVaultExecution.agentState !== AgentState.Executing) throw new Error("Vault fill cancelled.");

      // Retrieve the vault field value (never logged, never stored)
      const value = vaultSvc.getField(msg.fieldKey as import("@shared/types.js").VaultFieldKey);

      if (value === null) {
        chrome.tabs.sendMessage(senderTabId, {
          type: "VAULT_FILL_ERROR",
          handle: msg.handle,
          error: `Vault field "${msg.fieldKey}" not found`,
        }).catch(() => {});
        sendResponse({ ok: false, error: `Vault field "${msg.fieldKey}" not found` });
        break;
      }

      // Send the value directly to the content script in the requesting tab.
      // The value only lives in-memory and is immediately used to fill the DOM element.
      await chrome.tabs.sendMessage(senderTabId, {
        type: "VAULT_FILL_RESPONSE",
        handle: msg.handle,
        value,
      }, { frameId: 0, ...(sender.documentId ? { documentId: sender.documentId } : {}) });

      sendResponse({ ok: true });
      break;
    }

    case "VAULT_PASSPHRASE_RESPONSE": {
      // This is handled inside the VAULT_FILL_REQUEST listener above via onMessage.
      // If it arrives outside that context, acknowledge and discard.
      sendResponse({ ok: true });
      break;
    }

    // ─── Settings / Model Management ─────────────────────────────────────────

    case "PROFILE_CHANGED": {
      // User changed model profile in settings — persist and notify offscreen.
      await chrome.storage.local.set({ selected_profile: msg.profile });
      // Forward to offscreen so LLM/STT workers can reload on next request.
      await prepareModelStatus(msg.profile);
      await relayToOffscreen({ type: "PROFILE_CHANGED", profile: msg.profile });
      sendResponse({ ok: true });
      break;
    }

    case "START_MODEL_DOWNLOAD": {
      await prepareModelStatus(msg.profile);
      await relayToOffscreen({ type: "START_MODEL_DOWNLOAD", profile: msg.profile });
      sendResponse({ ok: true });
      break;
    }

    // ─── Tab / Navigation Operations ─────────────────────────────────────────

    case "TAB_OPERATION": {
      // Content script relays tab operations here because it lacks chrome.tabs access.
      try {
        switch (msg.operation) {
          case "open": {
            const url = msg.url ?? "about:newtab";
            const newTab = await chrome.tabs.create({ url, index: msg.index });
            sendResponse({ ok: true, tabId: newTab.id });
            break;
          }
          case "close": {
            const tabState = await getSessionState();
            if (tabState.activeTabId !== null) {
              await chrome.tabs.remove(tabState.activeTabId);
            }
            sendResponse({ ok: true });
            break;
          }
          case "switch": {
            if (msg.index !== undefined) {
              const tabs = await chrome.tabs.query({ currentWindow: true });
              const target = tabs[msg.index];
              if (target?.id) {
                await chrome.tabs.update(target.id, { active: true });
                sendResponse({ ok: true });
              } else {
                sendResponse({ ok: false, error: `No tab at index ${msg.index}` });
              }
            } else {
              sendResponse({ ok: false, error: "TAB_OPERATION switch requires an index" });
            }
            break;
          }
          default: {
            sendResponse({ ok: false, error: `Unknown tab operation: ${String(msg.operation)}` });
          }
        }
      } catch (err: unknown) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
      break;
    }

    // ─── TTS / Speech ─────────────────────────────────────────────────────────

    case "SPEAK": {
      broadcastToPanel({ type: "SPEAKING", text: msg.text });
      // Content script requests TTS (from a "read" action summary or "ask" response).
      // Forward to offscreen where the TTS engine runs.
      await relayToOffscreen({ type: "SPEAK", text: msg.text });
      sendResponse({ ok: true });
      break;
    }

    default: {
      sendResponse({ ok: false, error: `Unknown message type: ${(msg as BaseMsg).type}` });
    }
  }
}

// Need a local type for the default branch
interface BaseMsg { type: string }

// ─── Command Listener ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command: string) => {
  if (command === "toggle-listening") {
    toggleListening().catch((err: unknown) => {
      console.error("[SW] Toggle listening error:", err);
    });
  }
});

// ─── Install / Update Handler ─────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(
  async (details: chrome.runtime.InstalledDetails) => {
    console.log(`[SW] onInstalled: reason=${details.reason}`);

    // Initialize fresh session state
    await setSessionState(defaultSessionState());

    // Set up keepalive alarm
    await chrome.alarms.create(SW_KEEPALIVE_ALARM, {
      periodInMinutes: SW_KEEPALIVE_ALARM_PERIOD_MINUTES,
    });

    // Open onboarding on first install
    if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("src/onboarding/onboarding.html"),
      });
    }
  }
);

// ─── Alarm Handler (Keepalive) ────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm: chrome.alarms.Alarm) => {
  if (alarm.name === SW_KEEPALIVE_ALARM) {
    const state = await getSessionState();

    if (state.listeningEnabled) {
      if (!await hasOffscreenDocument()) {
        await ensureOffscreenDocument();
        const { selected_profile } = await chrome.storage.local.get("selected_profile");
        try {
          await relayToOffscreen({ type: "START_AUDIO", profile: typeof selected_profile === "string" ? selected_profile : "essential" });
        } catch (error) {
          await updateSessionState({ listeningEnabled: false, agentState: AgentState.Error });
          await updateBadge(false);
          broadcastToPanel({ type: "AGENT_STATE_CHANGED", state: AgentState.Error, error: String(error) });
        }
      } else {
        await relayToOffscreen({ type: "KEEPALIVE" });
      }
      await updateSessionState({ lastKeepalive: Date.now() });
    }
  }
});

// ─── Startup Handler ──────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(() => {
  // Reset session state on browser start
  setSessionState(defaultSessionState()).catch(console.error);
});

console.log("[SW] VoxPilot service worker loaded.");
