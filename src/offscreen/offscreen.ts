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
import { normalizeModelProfile } from "@shared/model-profiles.js";
import { AgentState } from "@shared/types.js";
import type { VoxPilotMessage } from "@shared/messages.js";

// ─── Module-level singletons (safe here — offscreen is not the SW) ────────────

let audioCapture: AudioCapture | null = null;
let vad: VAD | null = null;
let tts: TTS | null = null;
let agentCore: AgentCore | null = null;

/** Audio is independent of model residency and the popup's lifetime. */
let pipelineRunning = false;
let audioOperation: Promise<void> = Promise.resolve();


function getCore(): AgentCore {
  tts ??= new TTS();
  agentCore ??= new AgentCore({ tts });
  return agentCore;
}

async function startAudioPipeline(profileStr = "essential"): Promise<void> {
  if (pipelineRunning) return;
  const core = getCore();
  try {
    // initialize is idempotent: setup's loaded models are reused on ordinary starts.
    await core.initialize(normalizeModelProfile(profileStr));
    vad ??= new VAD({
      onSpeechStart: () => core.onSpeechStart(),
      onSpeechDiscard: () => core.onSpeechDiscard(),
      onSpeechEnd: audio => { void core.onSpeechEnd(audio); },
    });
    audioCapture ??= new AudioCapture({
      bufferSize: 2048,
      onAudioData: data => {
        // Browser TTS is not routed through our audio graph. Do not let its echo
        // become another command now that feedback no longer holds the command lock.
        if (tts?.isSpeaking) {
          if (vad?.currentState !== "silence") core.onSpeechDiscard();
          vad?.stop();
          return;
        }
        if (pipelineRunning) { void vad?.start(); vad?.processAudioChunk(data); }
      },
      onAudioLevel: level => {
        void sendToSW({ type: "AUDIO_LEVEL", level, isSpeech: vad?.currentState === "speech" });
      },
    });
    await audioCapture.start();
    await vad.start();
    core.resumeListening();
    pipelineRunning = true;
  } catch (err) {
    audioCapture?.stop();
    vad?.stop();
    core.pauseListening();
    pipelineRunning = false;
    // Let the service worker return a real failure to the popup, not a false success.
    throw new Error(`Could not start microphone: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function stopAudioPipeline(): Promise<void> {
  getCore().pauseListening();
  tts?.stop();
  vad?.stop();
  audioCapture?.stop();
  pipelineRunning = false;
  // Keep workers resident. Pausing the microphone must not trigger another model load.
}

function changeAudio(start: boolean, profile?: string): Promise<void> {
  const operation = audioOperation.then(() => start ? startAudioPipeline(profile) : stopAudioPipeline());
  audioOperation = operation.catch(() => {});
  return operation;
}

// ─── SW Message Helper ────────────────────────────────────────────────────────

/**
 * Send a message to the service worker.
 * This is the ONLY chrome API available in the offscreen context.
 */
async function sendToSW(msg: VoxPilotMessage): Promise<void> {
  try {
    const response = await chrome.runtime.sendMessage({ ...msg, target: "sw" });
    if (response?.ok === false && ["PLAN_PRODUCED", "REQUEST_SNAPSHOT", "RELAY_ACTION"].includes(msg.type)) {
      throw new Error(response.error ?? "Background operation failed");
    }
  } catch (err: unknown) {
    // SW may have been restarted — this is expected occasionally
    if (["PLAN_PRODUCED", "REQUEST_SNAPSHOT", "RELAY_ACTION"].includes(msg.type)) throw err;
    console.debug("[Offscreen] Notification could not be delivered:", err);
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (rawMsg: unknown, _sender, sendResponse: (r?: unknown) => void): boolean => {
    const msg = rawMsg as VoxPilotMessage;
    if (!msg || msg.target !== "offscreen") return false;

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
      await changeAudio(true, msg.profile);
      break;

    case "STOP_AUDIO":
      await changeAudio(false);
      break;

    case "PAGE_SNAPSHOT":
      // Forward snapshot to agent core for LLM planning
      await agentCore?.onPageSnapshot(msg.snapshot);
      break;

    case "EXECUTE_TEXT_COMMAND":
      // Execute text command via AgentCore pipeline (fast path or LLM planning)
      await agentCore?.executeCommandText(msg.text);
      break;

    case "EXECUTE_PLAN":
      // Execute a confirmed plan
      await agentCore?.executePlan(msg.plan, msg.tabId);
      break;

    case "USER_ANSWER":
      // Forward user's response to an `ask` action
      agentCore?.onUserAnswer(msg.answer);
      break;

    case "SPEAK": {
      // Content script or SW requested speech synthesis (FR-VOICE-04)
      if (!tts) {
        tts = new TTS();
      }
      void tts.speak(msg.text).catch(error => {
        void sendToSW({ type: "OFFSCREEN_ERROR", source: "tts", message: String(error) });
      }).finally(() => { void sendToSW({ type: "TTS_DONE" }); });
      break;
    }

    case "UNDO_LAST_ACTION": {
      // Revert the last reversible action (FR-SAFE-03)
      await agentCore?.undo();
      break;
    }

    case "START_MODEL_DOWNLOAD": {
      const core = getCore();
      void core.loadProfile(normalizeModelProfile(msg.profile)).catch(err => {
        if (err instanceof Error && err.name === "AbortError") return;
        void sendToSW({ type: "OFFSCREEN_ERROR", source: "llm", message: `Model preparation failed: ${err instanceof Error ? err.message : String(err)}` });
      });
      break;
    }

    case "PROFILE_CHANGED": {
      const core = getCore();
      void core.loadProfile(normalizeModelProfile(msg.profile)).then(() => {
        if (pipelineRunning) core.resumeListening();
      }).catch(err => {
        if (err instanceof Error && err.name === "AbortError") return;
        void sendToSW({ type: "OFFSCREEN_ERROR", source: "llm", message: String(err) });
      });
      break;
    }

    case "EXECUTION_DONE": {
      // Plan execution finished in tab — reset AgentCore to Listening state
      agentCore?.onExecutionDone();
      break;
    }

    case "AGENT_STATE_CHANGED":
      if (msg.state === AgentState.Executing) agentCore?.onExecutionStarted();
      break;

    case "COMMAND_NOTICE":
    case "PERFORMANCE_SAMPLE":
    case "GET_DIAGNOSTICS":
    case "GET_MODEL_STATUS":
    case "GET_SESSION_STATE":
    case "GET_AUDIT_LOG":
    case "DIRECT_TRANSCRIPT":
    case "AUDIO_LEVEL":
    case "TOGGLE_LISTENING":
    case "MODEL_LOAD_PROGRESS":
    case "SESSION_STATE_UPDATE":
    case "TRANSCRIPT_UPDATE":
    case "PLAN_READY":
    case "CONFIRM_PLAN":
    case "CANCEL_PLAN":
    case "TTS_DONE":
    case "TRIGGER_MACRO":
    case "SAVE_MACRO":
    case "DELETE_MACRO":
    case "GET_MACROS":
    case "VAULT_PASSPHRASE_RESPONSE":
    case "VAULT_FILL_RESPONSE":
    case "VAULT_FILL_REQUEST":
    case "VAULT_LOCK":
    case "OFFSCREEN_ERROR":
    case "REQUEST_SNAPSHOT":
    case "PLAN_PRODUCED":
    case "LLM_TOKEN":
    case "VAULT_PASSPHRASE_REQUEST":
    case "VAULT_UNLOCK_FAILED":
      // Handled by Service Worker or Panel — ignored by Offscreen
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
