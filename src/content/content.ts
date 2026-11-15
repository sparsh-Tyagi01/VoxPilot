/**
 * @file src/content/content.ts
 * @description VoxPilot content script — injected into every web page frame.
 *
 * Responsibilities:
 * 1. Listen for messages from the Service Worker (relayed from offscreen).
 * 2. Build DOM snapshots of interactive page elements.
 * 3. Execute agent actions (click, type, scroll, navigate, etc.).
 * 4. Render the isolated shadow-root overlay (badges, highlights, confirmations).
 *
 * Security constraints:
 * - Makes NO network requests (IR-COM-02).
 * - All overlay UI lives inside a closed shadow root (page scripts cannot access it).
 * - Page content is never sent anywhere except to the SW → offscreen pipeline.
 * - Input to the agent is ALWAYS from user voice; page text is only used to find targets.
 */

import { SnapshotBuilder } from "./snapshot.js";
import { ActionExecutor } from "./executor.js";
import { OverlayManager } from "./overlay/overlay.js";
import type { VoxPilotMessage } from "@shared/messages.js";

// ─── Module-level singletons ─────────────────────────────────────────────────

const snapshotBuilder = new SnapshotBuilder();
const overlay = new OverlayManager();
const executor = new ActionExecutor(snapshotBuilder.handles);

// ─── Message Handler ──────────────────────────────────────────────────────────

/**
 * Central message listener for all messages from the Service Worker.
 * Returns `true` for async responses; synchronous where possible.
 */
chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void): boolean => {
    const msg = rawMsg as VoxPilotMessage;

    switch (msg.type) {

      case "CAPTURE_SNAPSHOT": {
        // Build DOM snapshot synchronously (must complete in ≤50ms per NFR-PERF-08)
        const snapshot = snapshotBuilder.build();
        sendResponse({ type: "SNAPSHOT_RESPONSE", snapshot });
        return false; // synchronous response
      }

      case "EXECUTE_IN_PAGE": {
        // Execute the plan actions asynchronously
        (async () => {
          try {
            await executor.executePlan(msg.plan);
            sendResponse({ type: "EXECUTION_DONE", success: true });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error("[VoxPilot content] Execution error:", message);
            sendResponse({ type: "EXECUTION_DONE", success: false, error: message });
          }
        })();
        return true; // async response
      }

      case "SHOW_CONFIRMATION": {
        // Show inline confirmation overlay for R3/R4 plans
        overlay.showConfirmation(msg.plan).then((confirmed: boolean) => {
          chrome.runtime.sendMessage({ type: "IN_PAGE_CONFIRM", confirmed });
        }).catch((err: unknown) => {
          console.error("[VoxPilot content] Confirmation overlay error:", err);
          chrome.runtime.sendMessage({ type: "IN_PAGE_CONFIRM", confirmed: false });
        });
        sendResponse({ ok: true });
        return false;
      }

      case "HIDE_CONFIRMATION": {
        overlay.hideConfirmation();
        sendResponse({ ok: true });
        return false;
      }

      case "SHOW_BADGES": {
        // Render set-of-marks numbered badges
        const snapshot = snapshotBuilder.build();
        overlay.showBadges(snapshot.elements);
        sendResponse({ ok: true });
        return false;
      }

      case "HIDE_BADGES": {
        overlay.hideBadges();
        sendResponse({ ok: true });
        return false;
      }

      case "HIGHLIGHT_ELEMENT": {
        overlay.highlightElement(msg.handle);
        sendResponse({ ok: true });
        return false;
      }

      case "SHOW_LISTENING": {
        overlay.setListeningState(msg.agentState);
        sendResponse({ ok: true });
        return false;
      }

      case "PING": {
        sendResponse({ type: "PONG" });
        return false;
      }

      default: {
        sendResponse({ ok: false, error: `Unknown message type: ${(msg as { type: string }).type}` });
        return false;
      }
    }
  }
);

console.debug("[VoxPilot] Content script initialised on", window.location.href);

