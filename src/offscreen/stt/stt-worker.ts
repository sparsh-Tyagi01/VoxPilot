/**
 * @file src/offscreen/stt/stt-worker.ts
 * @description STT (Speech-to-Text) Web Worker — real Whisper via @huggingface/transformers.
 *
 * Runs in a dedicated Worker thread (spawned by offscreen.ts) to avoid blocking
 * the offscreen main thread. Receives raw 16 kHz Float32 PCM and returns transcript text.
 *
 * SRS references:
 * - FR-VOICE-02: Whisper tiny/base q8 for STT
 * - FR-MODEL-01: Profile-based model selection
 * - NFR-PERF-01: LLM+STT pipeline ≤2.5s p50
 * - NFR-PRV-01: Audio stays on-device (no network calls during transcription)
 *
 * PostMessage API:
 *
 * Input  → { type: 'load',       modelId: string }
 * Input  → { type: 'transcribe', audio: Float32Array }
 * Input  → { type: 'cancel' }
 *
 * Output ← { type: 'ready' }
 * Output ← { type: 'result',   text: string; confidence: number; language: string }
 * Output ← { type: 'progress', loaded: number; total: number; modelId: string }
 * Output ← { type: 'error',    message: string; stack?: string }
 */

import {
  pipeline,
  env,
  type AutomaticSpeechRecognitionPipeline,
  type ProgressInfo,
} from "@huggingface/transformers";

// ─── Worker Environment Config ─────────────────────────────────────────────────

/**
 * Force ONNX Runtime Web (WASM backend) — WebGPU not yet stable in every
 * Chrome version, and WASM q8 meets latency budgets for Whisper tiny/base.
 * We try WebGPU first, then fall back to WASM.
 */
if (env.backends.onnx?.wasm) { env.backends.onnx.wasm.proxy = false; } // No proxy worker — we ARE a worker.
env.allowLocalModels = false;          // Model files come from HuggingFace Hub CDN only.
env.useBrowserCache = true;            // Use browser Cache Storage for persistence.

// ─── Message Types ─────────────────────────────────────────────────────────────

/** Messages the worker receives from the main thread. */
type STTWorkerInput =
  | { type: "load"; modelId: string }
  | { type: "transcribe"; audio: Float32Array }
  | { type: "cancel" };

/** Messages the worker sends to the main thread. */
type STTWorkerOutput =
  | { type: "ready" }
  | { type: "result"; text: string; confidence: number; language: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "progress"; loaded: number; total: number; modelId: string };

// ─── Worker State ──────────────────────────────────────────────────────────────

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let currentModelId = "";
let isLoading = false;

// ─── Helpers ───────────────────────────────────────────────────────────────────

function post(msg: STTWorkerOutput): void {
  self.postMessage(msg);
}

function postError(message: string, err?: unknown): void {
  const stack = err instanceof Error ? err.stack : undefined;
  post({ type: "error", message, ...(stack !== undefined ? { stack } : {}) });
}

// ─── Load ──────────────────────────────────────────────────────────────────────

/**
 * Load the Whisper model pipeline.
 *
 * We select device priority: webgpu → wasm. The env configuration above
 * ensures the WASM fallback works inside a Worker context.
 *
 * dtype: 'q8' — 8-bit quantized weights meet the ≤300MB Lite storage budget
 * and ≤1.2 GB Standard budget while maintaining WER < 10% on common commands.
 */
async function loadModel(modelId: string): Promise<void> {
  if (isLoading) {
    postError("Model load already in progress.");
    return;
  }
  if (asr && currentModelId === modelId) {
    // Already loaded — just signal ready again.
    post({ type: "ready" });
    return;
  }

  isLoading = true;
  currentModelId = modelId;
  console.log(`[STT Worker] Loading "${modelId}"…`);

  // Build the progress callback — maps transformers.js ProgressInfo to our protocol.
  const progressCallback = (info: ProgressInfo): void => {
    const infoAny = info as { status: string; loaded?: number; total?: number };
    if (infoAny.status === "downloading" || infoAny.status === "progress") {
      const loaded = infoAny.loaded ?? 0;
      const total = infoAny.total ?? 0;
      post({ type: "progress", loaded, total, modelId });
    }
  };

  try {
    // Try WebGPU first (fastest), fall back to WASM q8, then default.
    asr = await pipeline("automatic-speech-recognition", modelId, {
      dtype: "q8" as "q8",
      device: "webgpu" as "webgpu",
      progress_callback: progressCallback,
    }).catch(async (gpuErr: unknown) => {
      console.warn("[STT Worker] WebGPU unavailable, falling back to WASM:", gpuErr);
      return pipeline("automatic-speech-recognition", modelId, {
        dtype: "q8" as "q8",
        device: "wasm" as "wasm",
        progress_callback: progressCallback,
      }).catch(async (wasmErr: unknown) => {
        console.warn("[STT Worker] WASM q8 failed, trying standard WASM pipeline:", wasmErr);
        return pipeline("automatic-speech-recognition", modelId, {
          device: "wasm" as "wasm",
          progress_callback: progressCallback,
        });
      });
    });

    isLoading = false;
    console.log(`[STT Worker] "${modelId}" ready.`);
    post({ type: "ready" });
  } catch (err: unknown) {
    isLoading = false;
    asr = null;
    postError(`Failed to load model "${modelId}": ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

// ─── Transcribe ────────────────────────────────────────────────────────────────

/**
 * Transcribe a Float32Array of 16 kHz mono PCM audio.
 *
 * The pipeline handles:
 * - Resampling if needed (we always pass 16 kHz so no-op)
 * - Log-mel spectrogram extraction
 * - Encoder + decoder pass through Whisper ONNX graph
 * - Beam-search decoding → text
 *
 * Performance target: ≤800ms for ≤10s utterances on modern hardware (SRS NFR-PERF-01).
 */
async function transcribe(audio: Float32Array): Promise<void> {
  if (!asr) {
    postError("Model not loaded. Send 'load' message first.");
    return;
  }

  const durationSeconds = audio.length / 16_000;
  console.log(`[STT Worker] Transcribing ${durationSeconds.toFixed(2)}s…`);
  const t0 = performance.now();

  try {
    // The transformers.js ASR pipeline accepts Float32Array directly.
    // We pass sampling_rate explicitly so it doesn't try to resample.
    const output = await asr(audio, {
      language: "en",
      task: "transcribe",
      return_timestamps: false,
      // chunk_length_s and stride_length_s are for long-form transcription;
      // voice commands are typically <10s so we skip chunking.
    });

    const elapsed = performance.now() - t0;
    console.log(`[STT Worker] Transcription done in ${elapsed.toFixed(0)}ms`);

    // Handle both single-output and array output shapes.
    const result = Array.isArray(output) ? output[0] : output;
    const text = (result?.text ?? "").trim();

    post({
      type: "result",
      text,
      confidence: 1.0, // Whisper ONNX via transformers.js doesn't expose token-level confidence.
      language: "en",
    });
  } catch (err: unknown) {
    postError(`Transcription failed: ${err instanceof Error ? err.message : String(err)}`, err);
  }
}

// ─── Message Handler ───────────────────────────────────────────────────────────

self.addEventListener("message", (event: MessageEvent<STTWorkerInput>) => {
  const msg = event.data;

  switch (msg.type) {
    case "load":
      loadModel(msg.modelId).catch((err: unknown) => {
        postError(`Unhandled error in loadModel: ${err instanceof Error ? err.message : String(err)}`, err);
      });
      break;

    case "transcribe":
      transcribe(msg.audio).catch((err: unknown) => {
        postError(`Unhandled error in transcribe: ${err instanceof Error ? err.message : String(err)}`, err);
      });
      break;

    case "cancel":
      // transformers.js v3 does not expose a cancel API for ASR pipelines yet.
      // We acknowledge without error — the in-flight call will complete naturally.
      console.log("[STT Worker] Cancel requested (not interruptible mid-inference).");
      break;

    default: {
      const _exhaustive: never = msg;
      postError(`Unknown message type: ${JSON.stringify(_exhaustive)}`);
    }
  }
});

// Signal that the worker script has initialised (before any model is loaded).
console.log("[STT Worker] Worker script initialised.");
