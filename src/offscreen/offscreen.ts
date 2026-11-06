/**
 * @file src/offscreen/offscreen.ts
 * @description Entry point for the VoxPilot offscreen document.
 *
 * This module bootstraps all subsystems that require a persistent background
 * context: AudioCapture, VAD, STT worker, LLM worker, TTS, and AgentCore.
 *
 * Message routing (this document):
 *   - Receives: START_AUDIO, STOP_AUDIO, EXECUTE_PLAN, PAGE_SNAPSHOT, KEEPALIVE, USER_ANSWER
 *   - Sends:    TRANSCRIPT, PLAN_PRODUCED, REQUEST_SNAPSHOT, OFFSCREEN_ERROR, TTS_DONE, RELAY_ACTION
 *
 * Constraints (MV3 Offscreen):
 *   - Only chrome.runtime.sendMessage() is available (no tabs, storage, etc.)
 *   - The document can be garbage-collected if inactive — the SW alarm keeps it alive
 */

import { AudioCapture } from "./audio/capture.js";
import { VAD } from "./audio/vad.js";
import { TTS } from "./audio/tts.js";
import { AgentCore } from "./agent/agent-core.js";
import type { VoxPilotMessage } from "@shared/messages.js";

// ─── Module-level singletons (safe here — offscreen is not the SW) ────────────

let audioCapture: AudioCapture | null = null;
let vad: VAD | null = null;
let tts: TTS | null = null;
let agentCore: AgentCore | null = null;

/** Whether the audio pipeline is currently running. */
let pipelineRunning = false;

// ─── Initialization ───────────────────────────────────────────────────────────

/**
 * Initialize all subsystems.
 * Called on START_AUDIO message from the service worker.
 */
async function startAudioPipeline(): Promise<void> {
  if (pipelineRunning) {
    console.warn("[Offscreen] Audio pipeline already running — ignoring START_AUDIO.");
    return;
  }

  try {
    console.log("[Offscreen] Initializing audio pipeline...");

    // Initialize TTS first (fastest, no worker required)
    tts = new TTS();

    // Initialize agent core (spawns STT + LLM workers)
    agentCore = new AgentCore({ tts });

    // Initialize VAD with callbacks to agent core
    vad = new VAD({
      onSpeechStart: () => {
        agentCore?.onSpeechStart();
      },
      onSpeechEnd: (audioData: Float32Array) => {
        agentCore?.onSpeechEnd(audioData);
      },
    });

    // Initialize audio capture and wire to VAD
    audioCapture = new AudioCapture({
      onAudioData: (data: Float32Array) => {
        vad?.processAudioChunk(data);
      },
    });

    await audioCapture.start();
    await vad.start();
    await agentCore.initialize();

    pipelineRunning = true;
    console.log("[Offscreen] Audio pipeline started successfully.");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    console.error("[Offscreen] Failed to start audio pipeline:", err);
    pipelineRunning = false;

    // Notify SW of the failure
    await sendToSW({
      type: "OFFSCREEN_ERROR",
      source: "audio",
      message: `Failed to start audio pipeline: ${message}`,
      ...(stack !== undefined ? { stack } : {}),
    });
  }
}

/**
 * Stop all subsystems and release resources.
 * Called on STOP_AUDIO message from the service worker.
 */
async function stopAudioPipeline(): Promise<void> {
  if (!pipelineRunning) return;

  try {
    tts?.stop();
    vad?.stop();
    audioCapture?.stop();
    agentCore?.dispose();

    audioCapture = null;
    vad = null;
    tts = null;
    agentCore = null;
    pipelineRunning = false;

    console.log("[Offscreen] Audio pipeline stopped.");
  } catch (err: unknown) {
    console.error("[Offscreen] Error stopping pipeline:", err);
  }
}

// ─── SW Message Helper ────────────────────────────────────────────────────────

/**
 * Send a message to the service worker.
 * This is the ONLY chrome API available in the offscreen context.
 */
async function sendToSW(msg: VoxPilotMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(msg);
  } catch (err: unknown) {
    // SW may have been restarted — this is expected occasionally
    console.warn("[Offscreen] Failed to send message to SW:", err);
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender, sendResponse: (r?: unknown) => void): boolean => {
    const msg = rawMsg as VoxPilotMessage;

    handleMessage(msg).then(() => sendResponse({ ok: true })).catch((err: unknown) => {
      console.error("[Offscreen] Message handler error:", err);
      sendResponse({ ok: false, error: String(err) });
    });

    // Return true for async sendResponse
    return true;
  }
);

async function handleMessage(msg: VoxPilotMessage): Promise<void> {
  switch (msg.type) {
    case "START_AUDIO":
      await startAudioPipeline();
      break;

    case "STOP_AUDIO":
      await stopAudioPipeline();
      break;

    case "PAGE_SNAPSHOT":
      // Forward snapshot to agent core for LLM planning
      await agentCore?.onPageSnapshot(msg.snapshot);
      break;

    case "EXECUTE_PLAN":
      // Execute a confirmed plan
      await agentCore?.executePlan(msg.plan, msg.tabId);
      break;

    case "USER_ANSWER":
      // Forward user's response to an `ask` action
      agentCore?.onUserAnswer(msg.answer);
      break;

    case "KEEPALIVE":
      // No-op — just prevents GC by receiving a message
      console.debug("[Offscreen] Keepalive received.");
      break;

    default:
      console.warn(`[Offscreen] Unhandled message type: ${(msg as { type: string }).type}`);
  }
}

// ─── Expose send helper for sub-modules ──────────────────────────────────────

/**
 * Sub-modules (AgentCore, etc.) import this to send messages back to SW.
 * This avoids passing chrome.runtime through the entire call chain.
 */
export { sendToSW };

console.log("[Offscreen] VoxPilot offscreen document loaded.");
