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
  OFFSCREEN_KEEPALIVE_INTERVAL_MS,
} from "@shared/constants.js";
import type { VoxPilotMessage, SessionStateUpdateMsg } from "@shared/messages.js";
import { AgentState } from "@shared/types.js";
import type { SessionState } from "@shared/types.js";

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
  // Broadcast to side panel (best-effort; panel may not be open)
  broadcastToPanel({ type: "SESSION_STATE_UPDATE", state });
}

/**
 * Partial update helper — reads, merges, writes.
 */
async function updateSessionState(
  partial: Partial<SessionState>
): Promise<SessionState> {
  const current = await getSessionState();
  const next = { ...current, ...partial };
  await setSessionState(next);
  return next;
}

// ─── Panel Broadcast ──────────────────────────────────────────────────────────

/**
 * Best-effort broadcast to the side panel.
 * Swallows "Could not establish connection" errors (panel not open).
 */
function broadcastToPanel(msg: VoxPilotMessage): void {
  chrome.runtime.sendMessage(msg).catch(() => {
    // Panel is not open — this is expected and not an error
  });
}

// ─── Offscreen Document Lifecycle ─────────────────────────────────────────────

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const OFFSCREEN_REASON: chrome.offscreen.Reason = chrome.offscreen?.Reason?.AUDIO_PLAYBACK ?? ("AUDIO_PLAYBACK" as chrome.offscreen.Reason);

/**
 * Ensure the offscreen document is open.
 * Uses the chrome.offscreen API (MV3).
 * Safe to call multiple times — only creates if not already open.
 */
async function ensureOffscreenDocument(): Promise<void> {
  // Check if offscreen is already open using the contexts API
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });

  if (contexts.length > 0) {
    // Already open; refresh keepalive timestamp
    await updateSessionState({ offscreenActive: true, lastKeepalive: Date.now() });
    return;
  }

  // Create the offscreen document
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [OFFSCREEN_REASON],
    justification:
      "VoxPilot requires persistent AudioContext for real-time microphone capture and on-device ONNX Runtime Web inference (STT + LLM). This cannot be done in the service worker.",
  });

  await updateSessionState({ offscreenActive: true, lastKeepalive: Date.now() });
  console.log("[SW] Offscreen document created.");
}

/**
 * Close the offscreen document.
 */
async function closeOffscreenDocument(): Promise<void> {
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // May throw if already closed — ignore
  }
  await updateSessionState({ offscreenActive: false });
  console.log("[SW] Offscreen document closed.");
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
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Content script in tab ${tabId} did not respond within ${CONTENT_SCRIPT_TIMEOUT_MS}ms`));
    }, CONTENT_SCRIPT_TIMEOUT_MS);

    chrome.tabs.sendMessage(tabId, msg, (response: VoxPilotMessage | null) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── Listening Toggle ─────────────────────────────────────────────────────────

/**
 * Toggle the listening state.
 * Creates or tears down the offscreen document as needed.
 */
async function toggleListening(): Promise<void> {
  const state = await getSessionState();

  if (state.listeningEnabled) {
    // Turn off: stop audio and close offscreen
    await chrome.runtime.sendMessage({ type: "STOP_AUDIO" }).catch(() => {});
    await closeOffscreenDocument();
    await updateSessionState({
      listeningEnabled: false,
      agentState: AgentState.Idle,
    });
    console.log("[SW] Listening stopped.");
  } else {
    // Turn on: get active tab, create offscreen, start audio
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tab?.id ?? null;

    await ensureOffscreenDocument();
    // Brief pause to let the offscreen document initialize
    await new Promise<void>((r) => setTimeout(r, 300));

    await chrome.runtime.sendMessage({ type: "START_AUDIO" }).catch(() => {});
    await updateSessionState({
      listeningEnabled: true,
      activeTabId: tabId,
      agentState: AgentState.Listening,
    });
    console.log(`[SW] Listening started (active tab: ${tabId}).`);
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

    // Run async handler and plumb errors to console
    handleMessage(msg, sender, sendResponse).catch((err: unknown) => {
      console.error("[SW] Message handler error:", err);
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
  switch (msg.type) {
    // ── Panel → SW ─────────────────────────────────────────────────────────
    case "TOGGLE_LISTENING": {
      await toggleListening();
      sendResponse({ ok: true });
      break;
    }

    case "GET_SESSION_STATE": {
      const state = await getSessionState();
      sendResponse(state);
      break;
    }

    case "CONFIRM_PLAN": {
      // Relay plan confirmation to offscreen
      const state = await getSessionState();
      if (state.currentPlan && state.activeTabId !== null) {
        await chrome.runtime.sendMessage({
          type: "EXECUTE_PLAN",
          plan: state.currentPlan,
          tabId: state.activeTabId,
        });
        await updateSessionState({ agentState: AgentState.Executing });
      }
      sendResponse({ ok: true });
      break;
    }

    case "CANCEL_PLAN": {
      await updateSessionState({
        agentState: AgentState.Listening,
        currentPlan: null,
      });
      sendResponse({ ok: true });
      break;
    }

    case "UNDO_LAST_ACTION": {
      // TODO: Implement undo by relaying to offscreen undo stack
      console.warn("[SW] Undo not yet implemented.");
      sendResponse({ ok: false, error: "Undo not yet implemented" });
      break;
    }

    case "TRIGGER_MACRO": {
      // TODO: Load macro from storage and execute its plan
      console.warn("[SW] Macro trigger not yet implemented.");
      sendResponse({ ok: false, error: "Macros not yet implemented" });
      break;
    }

    // ── Offscreen → SW ─────────────────────────────────────────────────────
    case "TRANSCRIPT": {
      await updateSessionState({
        lastTranscript: msg.text,
        agentState: msg.isFinal ? AgentState.Routing : AgentState.Transcribing,
      });
      // Forward to panel for live display
      broadcastToPanel({ type: "TRANSCRIPT_UPDATE", text: msg.text, isFinal: msg.isFinal });
      sendResponse({ ok: true });
      break;
    }

    case "PLAN_PRODUCED": {
      const state = await updateSessionState({
        currentPlan: msg.plan,
        agentState: msg.plan.requiresConfirmation
          ? AgentState.Confirming
          : AgentState.Executing,
      });

      broadcastToPanel({ type: "PLAN_READY", plan: msg.plan });

      // If confirmation required, show overlay in content script
      if (msg.plan.requiresConfirmation && state.activeTabId !== null) {
        await sendToContentScript(state.activeTabId, {
          type: "SHOW_CONFIRMATION",
          plan: msg.plan,
        }).catch((err: unknown) => {
          console.error("[SW] Failed to show confirmation overlay:", err);
        });
      } else if (!msg.plan.requiresConfirmation && state.activeTabId !== null) {
        // Auto-execute low-risk plans
        await sendToContentScript(state.activeTabId, {
          type: "EXECUTE_IN_PAGE",
          plan: msg.plan,
        }).catch((err: unknown) => {
          console.error("[SW] Failed to relay plan to content script:", err);
        });
      }

      sendResponse({ ok: true });
      break;
    }

    case "REQUEST_SNAPSHOT": {
      // Relay snapshot request to content script, then forward response to offscreen
      try {
        const response = await sendToContentScript(msg.tabId, {
          type: "CAPTURE_SNAPSHOT",
        });
        if (response?.type === "SNAPSHOT_RESPONSE") {
          await chrome.runtime.sendMessage({
            type: "PAGE_SNAPSHOT",
            snapshot: response.snapshot,
          });
        }
      } catch (err: unknown) {
        console.error("[SW] Snapshot relay failed:", err);
      }
      sendResponse({ ok: true });
      break;
    }

    case "OFFSCREEN_ERROR": {
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
      await updateSessionState({ agentState: AgentState.Listening });
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
      if (msg.success) {
        await updateSessionState({ agentState: AgentState.Listening });
      } else {
        const { errorCount } = await getSessionState();
        await updateSessionState({
          agentState: AgentState.Error,
          errorCount: errorCount + 1,
        });
      }
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
      if (msg.confirmed) {
        await handleMessage({ type: "CONFIRM_PLAN" }, sender, sendResponse);
      } else {
        await handleMessage({ type: "CANCEL_PLAN" }, sender, sendResponse);
      }
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

    // Open side panel when toolbar icon is clicked
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

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
      // Check if offscreen is still alive; recreate if not
      const now = Date.now();
      if (now - state.lastKeepalive > OFFSCREEN_KEEPALIVE_INTERVAL_MS) {
        console.warn("[SW] Offscreen document may be stale — recreating.");
        await ensureOffscreenDocument();
      } else {
        // Ping offscreen to prevent GC
        await chrome.runtime.sendMessage({ type: "KEEPALIVE" }).catch(() => {
          // Offscreen dead — recreate
          ensureOffscreenDocument().catch(console.error);
        });
      }
      await updateSessionState({ lastKeepalive: now });
    }
  }
});

// ─── Startup Handler ──────────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(() => {
  // Reset session state on browser start
  setSessionState(defaultSessionState()).catch(console.error);
});

console.log("[SW] VoxPilot service worker loaded.");
