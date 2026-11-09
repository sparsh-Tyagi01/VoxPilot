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
import type { VoxPilotMessage } from "@shared/messages.js";
import { AgentState } from "@shared/types.js";
import type { SessionState, AgentPlan, PageSnapshot } from "@shared/types.js";
import { loadMacros, saveMacros, generateMacroId, deriveTriggerWords } from "@shared/macros.js";
import { appendHistory, clearHistory, loadHistory, generateHistoryId } from "@shared/history.js";
import { VaultService } from "@vault/vault.js";
import { IntentRouter } from "../offscreen/agent/intent-router.js";

// Global intent router instance for SW-level fast-path execution
const swIntentRouter = new IntentRouter();

// Command deduplication cache to prevent double-firing from dual recognition engines
let lastExecutedCommand = "";
let lastExecutedCommandTime = 0;

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

/**
 * Send a message to the offscreen document.
 * The offscreen doc receives all chrome.runtime messages (it has no other comms path).
 */
async function relayToOffscreen(msg: VoxPilotMessage): Promise<void> {
  // Ensure offscreen is active before sending
  await ensureOffscreenDocument();
  // Offscreen receives via chrome.runtime.onMessage — no targetId needed
  await chrome.runtime.sendMessage(msg).catch(() => {
    // Offscreen may have restarted — not fatal for best-effort relay
    console.warn("[SW] Could not relay to offscreen:", (msg as { type: string }).type);
  });
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
  // 1. Try active tab in last focused window (the browser window behind the side panel)
  const tabsInLastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  for (const t of tabsInLastFocused) {
    if (t.id && !isInternalUrl(t.url)) return t;
  }

  // 2. Try active tab in current window
  const tabsCurrent = await chrome.tabs.query({ active: true, currentWindow: true });
  for (const t of tabsCurrent) {
    if (t.id && !isInternalUrl(t.url)) return t;
  }

  // 3. Fallback to any active tab across all windows
  const anyTabs = await chrome.tabs.query({ active: true });
  for (const t of anyTabs) {
    if (t.id && !isInternalUrl(t.url)) return t;
  }

  return tabsInLastFocused[0] ?? tabsCurrent[0] ?? anyTabs[0] ?? null;
}

/**
 * Execute plan actions in the target tab. First attempts execution via the
 * page content script; if unavailable or unmounted, falls back to direct
 * chrome.scripting.executeScript to guarantee immediate execution.
 */
async function executePlanActions(tabId: number, plan: AgentPlan): Promise<void> {
  // 1. Direct handling of Tab and Navigation operations at SW level
  for (const action of plan.actions) {
    if (action.type === "tab") {
      try {
        if (action.operation === "open") {
          await chrome.tabs.create({ url: action.url ?? "chrome://newtab" });
        } else if (action.operation === "close") {
          const [cur] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (cur?.id) await chrome.tabs.remove(cur.id);
        } else if (action.operation === "switch") {
          const tabs = await chrome.tabs.query({ currentWindow: true });
          const curIdx = tabs.findIndex((t) => t.active);
          if (curIdx !== -1 && tabs.length > 1) {
            const delta = action.index ?? 1;
            const nextIdx = (curIdx + delta + tabs.length) % tabs.length;
            const target = tabs[nextIdx];
            if (target?.id) await chrome.tabs.update(target.id, { active: true });
          }
        }
      } catch (err) {
        console.error("[SW] Direct tab operation failed:", err);
      }
    } else if (action.type === "navigate") {
      try {
        console.log(`[SW] Direct navigate action: "${action.url}" on tab ${tabId}`);
        if (action.url.includes("history.back") || action.url === "back") {
          await chrome.tabs.goBack(tabId).catch(async (e) => {
            console.warn("[SW] chrome.tabs.goBack failed, trying script:", e);
            await chrome.scripting.executeScript({ target: { tabId }, func: () => window.history.back() }).catch(() => {});
          });
        } else if (action.url.includes("history.forward") || action.url === "forward") {
          await chrome.tabs.goForward(tabId).catch(async (e) => {
            console.warn("[SW] chrome.tabs.goForward failed, trying script:", e);
            await chrome.scripting.executeScript({ target: { tabId }, func: () => window.history.forward() }).catch(() => {});
          });
        } else if (action.url.includes("location.reload") || action.url === "reload") {
          await chrome.tabs.reload(tabId).catch(async (e) => {
            console.warn("[SW] chrome.tabs.reload failed, trying script:", e);
            await chrome.scripting.executeScript({ target: { tabId }, func: () => window.location.reload() }).catch(() => {});
          });
        } else {
          await chrome.tabs.update(tabId, { url: action.url }).catch(console.error);
        }
      } catch (err) {
        console.error("[SW] Direct navigate operation failed:", err);
      }
    }
  }

  // Check if there are in-page DOM actions (scroll, click, type, etc.)
  const hasDomActions = plan.actions.some((a) =>
    ["scroll", "click", "type", "select", "toggle", "read", "fill_from_vault"].includes(a.type)
  );
  if (!hasDomActions) {
    return;
  }

  // 2. Attempt in-page execution via content script
  let executedInContent = false;
  try {
    const res = await sendToContentScript(tabId, {
      type: "EXECUTE_IN_PAGE",
      plan,
    });
    if (res && (res as any).success) {
      executedInContent = true;
    }
  } catch (err: unknown) {
    console.warn("[SW] Content script execution failed, falling back to direct chrome.scripting:", err);
  }

  // 3. Fallback direct script injection if content script is unavailable or failed
  if (!executedInContent) {
    for (const action of plan.actions) {
      if (action.type === "scroll") {
        const direction = action.direction;
        const amount = action.amount ?? 750;
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (dir: string, amt: number) => {
            const screenH = window.innerHeight || 800;
            const scrollDist = amt === 99999 ? 999999 : Math.max(amt, Math.round(screenH * 0.85));
            const y = dir === "up" ? -scrollDist : dir === "down" ? scrollDist : 0;
            const x = dir === "left" ? -scrollDist : dir === "right" ? scrollDist : 0;
            window.scrollBy({ left: x, top: y, behavior: "smooth" });
          },
          args: [direction, amount],
        }).catch((e: unknown) => console.error("[SW] Direct scroll script failed:", e));
      } else if (action.type === "click") {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (targetQuery: string) => {
            const q = targetQuery.trim().toLowerCase();
            const cleanQ = q.replace(/^(?:the|a|an)\s+/i, "").replace(/\s+(?:button|btn|link|tab|icon|menu)$/i, "").trim();
            const candidates = Array.from(document.querySelectorAll<HTMLElement>(
              "button, a, input, select, textarea, [role='button'], [role='link'], [role='tab'], [role='menuitem'], [tabindex='0'], h1, h2, h3, h4, p, span, li, b, strong"
            ));
            for (const el of candidates) {
              const text = el.innerText?.trim().toLowerCase() || el.textContent?.trim().toLowerCase() || "";
              const aria = el.getAttribute("aria-label")?.trim().toLowerCase() || "";
              if (
                text === q || text === cleanQ ||
                aria === q || aria === cleanQ ||
                (cleanQ.length >= 3 && (text.includes(cleanQ) || aria.includes(cleanQ)))
              ) {
                const interactive = el.closest<HTMLElement>("button, a, [role='button'], [role='link'], [tabindex='0']") || el;
                interactive.scrollIntoView({ behavior: "smooth", block: "nearest" });
                interactive.click();
                return;
              }
            }
          },
          args: [action.handle],
        }).catch((e: unknown) => console.error("[SW] Direct click script failed:", e));
      } else if (action.type === "type") {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (handleQuery: string, textToType: string) => {
            const q = handleQuery.trim().toLowerCase();
            let inputEl = document.querySelector<HTMLInputElement>(
              "input[type='search'], input[name*='search'], input[name='q'], input[id*='search'], input[placeholder*='search' i], textarea[name*='search'], [role='searchbox'], input[type='text'], input:not([type]), textarea"
            );
            if (!inputEl) {
              inputEl = Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea")).find(
                (el) => el.placeholder?.toLowerCase().includes(q) || el.name?.toLowerCase().includes(q) || el.id?.toLowerCase().includes(q)
              ) || null;
            }
            if (inputEl) {
              inputEl.focus();
              inputEl.value = textToType;
              inputEl.dispatchEvent(new Event("input", { bubbles: true }));
              inputEl.dispatchEvent(new Event("change", { bubbles: true }));
              inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              inputEl.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
              const form = inputEl.form || inputEl.closest("form");
              if (form) {
                try { form.requestSubmit(); } catch { form.submit(); }
              }
            } else if (q.includes("search")) {
              window.location.href = `https://www.google.com/search?q=${encodeURIComponent(textToType)}`;
            }
          },
          args: [action.handle, action.text],
        }).catch((e: unknown) => console.error("[SW] Direct type script failed:", e));
      } else if (action.type === "navigate") {
        if (action.url.startsWith("javascript:history.back")) {
          await chrome.scripting.executeScript({ target: { tabId }, func: () => window.history.back() }).catch(() => {});
        } else if (action.url.startsWith("javascript:history.forward")) {
          await chrome.scripting.executeScript({ target: { tabId }, func: () => window.history.forward() }).catch(() => {});
        } else if (action.url.startsWith("javascript:location.reload")) {
          await chrome.tabs.reload(tabId).catch(() => {});
        } else {
          await chrome.tabs.update(tabId, { url: action.url }).catch(console.error);
        }
      }
    }
  }
}

/**
 * Dispatch an AgentPlan to the appropriate tab or overlay.
 */
async function dispatchPlan(plan: AgentPlan): Promise<boolean> {
  const state = await updateSessionState({
    currentPlan: plan,
    agentState: plan.requiresConfirmation
      ? AgentState.Confirming
      : AgentState.Executing,
  });

  broadcastToPanel({ type: "PLAN_READY", plan });

  const targetTab = await getTargetTab();
  const targetTabId = targetTab?.id ?? state.activeTabId;

  if (targetTab?.url && isInternalUrl(targetTab.url)) {
    broadcastToPanel({
      type: "AGENT_STATE_CHANGED",
      state: AgentState.Listening,
      error: "Browser system pages (chrome://) cannot be scripted. Please test on any regular webpage.",
    });
    await relayToOffscreen({
      type: "SPEAK",
      text: "Browser internal pages cannot be controlled. Please test on a regular webpage.",
    });
    return false;
  }

  if (targetTabId === null) {
    console.warn("[SW] No valid target tab found for plan execution.");
    return false;
  }

  // If confirmation required, show overlay in content script
  if (plan.requiresConfirmation) {
    await sendToContentScript(targetTabId, {
      type: "SHOW_CONFIRMATION",
      plan,
    }).catch((err: unknown) => {
      console.error("[SW] Failed to show confirmation overlay:", err);
    });
  } else {
    // Auto-execute low-risk plans
    await executePlanActions(targetTabId, plan);
  }

  return true;
}

// ─── Offscreen Document Lifecycle ─────────────────────────────────────────────

const OFFSCREEN_URL = "src/offscreen/offscreen.html";
const OFFSCREEN_REASONS: chrome.offscreen.Reason[] = [
  (chrome.offscreen?.Reason?.USER_MEDIA ?? "USER_MEDIA") as chrome.offscreen.Reason,
  (chrome.offscreen?.Reason?.AUDIO_PLAYBACK ?? "AUDIO_PLAYBACK") as chrome.offscreen.Reason,
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
  const trySend = (): Promise<VoxPilotMessage | null> => {
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
      macro.useCount++;
      await saveMacros(macros);
      const macroState = await getSessionState();
      if (macroState.activeTabId !== null) {
        const macroPlan: AgentPlan = {
          intent: `Run macro: ${macro.name}`,
          risk: 1,
          requiresConfirmation: false,
          actions: macro.actions,
        };
        await sendToContentScript(macroState.activeTabId, {
          type: "EXECUTE_IN_PAGE",
          plan: macroPlan,
        });
      }
      sendResponse({ ok: true });
      break;
    }

    // ── Panel / Direct Speech → SW ──────────────────────────────────────────
    case "DIRECT_TRANSCRIPT": {
      const text = msg.text.trim();
      if (!text) {
        sendResponse({ ok: true });
        break;
      }

      console.log(`[SW] Direct transcript received: "${text}"`);
      await updateSessionState({
        lastTranscript: text,
        agentState: AgentState.Routing,
      });
      broadcastToPanel({ type: "TRANSCRIPT_UPDATE", text, isFinal: true });

      // Deduplication check: if identical command within 1.5 seconds, skip re-executing
      const now = Date.now();
      if (text.toLowerCase() === lastExecutedCommand.toLowerCase() && (now - lastExecutedCommandTime) < 1500) {
        console.log(`[SW] Duplicate command suppressed: "${text}"`);
        sendResponse({ ok: true, deduplicated: true });
        break;
      }

      // Check kill command
      if (swIntentRouter.isKillCommand(text)) {
        lastExecutedCommand = text;
        lastExecutedCommandTime = now;
        await updateSessionState({ agentState: AgentState.Listening, currentPlan: null });
        broadcastToPanel({ type: "AGENT_STATE_CHANGED", state: AgentState.Listening });
        sendResponse({ ok: true });
        break;
      }

      // Check undo command
      if (swIntentRouter.isUndoCommand(text)) {
        lastExecutedCommand = text;
        lastExecutedCommandTime = now;
        await relayToOffscreen({ type: "UNDO_LAST_ACTION" });
        sendResponse({ ok: true });
        break;
      }

      // Fast-path routing
      const plan = swIntentRouter.route(text);
      if (plan) {
        lastExecutedCommand = text;
        lastExecutedCommandTime = now;
        console.log(`[SW] Fast-path executing direct plan: "${plan.intent}"`);
        await dispatchPlan(plan);
        const doneAction = plan.actions.find((a) => a.type === "done") as { type: "done"; summary: string } | undefined;
        if (doneAction) {
          void relayToOffscreen({ type: "SPEAK", text: doneAction.summary });
        }
        broadcastToPanel({ type: "EXECUTION_DONE" as any, success: true });
      } else {
        // Fallback for complex queries or unmatched commands: forward to offscreen agent LLM planner
        console.log(`[SW] No fast-path match for "${text}" — forwarding to AgentCore for planning`);
        await updateSessionState({ agentState: AgentState.Planning });
        broadcastToPanel({ type: "AGENT_STATE_CHANGED", state: AgentState.Planning });
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
      const now = Date.now();
      // If this plan's intent corresponds to the command already executed via fast-path, skip re-execution
      if (msg.plan.intent.toLowerCase() === lastExecutedCommand.toLowerCase() && (now - lastExecutedCommandTime) < 2000) {
        console.log(`[SW] Redundant PLAN_PRODUCED suppressed: "${msg.plan.intent}"`);
        sendResponse({ ok: true });
        break;
      }
      await dispatchPlan(msg.plan);
      sendResponse({ ok: true });
      break;
    }

    case "REQUEST_SNAPSHOT": {
      // Relay snapshot request to content script, or capture directly via chrome.scripting
      try {
        const targetTab = await getTargetTab();
        const targetTabId = (msg.tabId && msg.tabId > 0) ? msg.tabId : targetTab?.id;
        if (!targetTabId) {
          throw new Error("No active tab found for snapshot");
        }

        let snapshot: PageSnapshot | null = null;
        try {
          const response = await sendToContentScript(targetTabId, {
            type: "CAPTURE_SNAPSHOT",
          });
          if (response?.type === "SNAPSHOT_RESPONSE") {
            snapshot = response.snapshot;
          }
        } catch (csErr) {
          console.warn("[SW] Content script snapshot unavailable, capturing via scripting:", csErr);
        }

        // Direct capture fallback if content script is unavailable or not mounted
        if (!snapshot) {
          const [execResult] = await chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: () => {
              const elements: any[] = [];
              const raw = Array.from(document.querySelectorAll(
                "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='tab']"
              ));
              let idx = 0;
              for (const el of raw.slice(0, 100)) {
                const tag = el.tagName.toLowerCase();
                const label = el.getAttribute("aria-label") || (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).placeholder || (el as HTMLInputElement).value || "";
                if (!label && tag === "a") continue;
                elements.push({
                  handle: `e${idx++}`,
                  tag,
                  label: label.slice(0, 100),
                  role: el.getAttribute("role") || tag,
                  inViewport: true,
                });
              }
              const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
                .map((h) => (h as HTMLElement).innerText?.trim())
                .filter(Boolean)
                .slice(0, 15);
              const mainEl = document.querySelector("main, article, [role='main'], #content, .content") || document.body;
              return {
                url: window.location.href,
                title: document.title,
                elements,
                headings,
                textSummary: (mainEl as HTMLElement)?.innerText?.trim().slice(0, 2500) || "",
                capturedAt: Date.now(),
                truncated: false,
              };
            },
          }).catch((err) => {
            console.error("[SW] Direct scripting snapshot failed:", err);
            return [null];
          });

          if (execResult?.result) {
            snapshot = execResult.result as PageSnapshot;
          }
        }

        if (snapshot) {
          await chrome.runtime.sendMessage({
            type: "PAGE_SNAPSHOT",
            snapshot,
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

    case "SAVE_MACRO": {
      const macros = await loadMacros();
      if (macros.length >= 50) {
        sendResponse({ ok: false, error: "Maximum 50 macros reached" });
        break;
      }
      const newMacro = {
        id: generateMacroId(),
        name: msg.name,
        triggerWords: deriveTriggerWords(msg.name),
        actions: msg.actions,
        createdAt: new Date().toISOString(),
        useCount: 0,
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
      await updateSessionState({ agentState: msg.state });
      broadcastToPanel({ type: "AGENT_STATE_CHANGED", state: msg.state });
      sendResponse({ ok: true });
      break;
    }

    case "MODEL_LOAD_PROGRESS": {
      // Forward model download progress to panel
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

      // Create a per-request vault service instance (SW is stateless)
      const vaultSvc = new VaultService();

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
      });

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
      await relayToOffscreen({ type: "PROFILE_CHANGED", profile: msg.profile });
      sendResponse({ ok: true });
      break;
    }

    case "START_MODEL_DOWNLOAD": {
      // Onboarding requested model download — relay to offscreen to begin.
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
