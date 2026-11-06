/**
 * @file src/offscreen/stt/stt-worker.ts
 * @description STT (Speech-to-Text) Web Worker using Whisper via ONNX Runtime Web.
 *
 * This worker runs in a separate thread to avoid blocking the main offscreen thread.
 * It receives audio chunks and returns transcription results.
 *
 * Production implementation will use:
 * - Model: openai/whisper-tiny or whisper-base (quantized to q8 ONNX)
 * - Runtime: @huggingface/transformers (ONNX Runtime Web backend)
 * - Language: auto-detect or configurable
 *
 * PostMessage interface:
 *
 * Input messages (main thread → worker):
 * ```ts
 * { type: 'transcribe', audio: Float32Array }
 * { type: 'load', modelId: string }
 * ```
 *
 * Output messages (worker → main thread):
 * ```ts
 * { type: 'result', text: string, confidence: number, language: string }
 * { type: 'ready' }
 * { type: 'error', message: string }
 * { type: 'progress', loaded: number, total: number, modelId: string }
 * ```
 */

// ─── Message Types ────────────────────────────────────────────────────────────

/** Messages the worker receives from the main thread. */
type STTWorkerInput =
  | { type: "load"; modelId: string }
  | { type: "transcribe"; audio: Float32Array };

/** Messages the worker sends to the main thread. */
type STTWorkerOutput =
  | { type: "ready" }
  | { type: "result"; text: string; confidence: number; language: string }
  | { type: "error"; message: string; stack?: string }
  | { type: "progress"; loaded: number; total: number; modelId: string };

// ─── Worker State ─────────────────────────────────────────────────────────────

/**
 * TODO: Replace with actual @huggingface/transformers pipeline instance.
 * ```ts
 * import { pipeline } from '@huggingface/transformers';
 * let asr: AutomaticSpeechRecognitionPipeline | null = null;
 * ```
 */
let modelLoaded = false;
let modelId = "onnx-community/whisper-tiny";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Post a typed message back to the main thread.
 */
function postResult(msg: STTWorkerOutput): void {
  self.postMessage(msg);
}

/**
 * Load the Whisper model.
 * TODO: Implement with @huggingface/transformers:
 * ```ts
 * asr = await pipeline('automatic-speech-recognition', modelId, {
 *   dtype: 'q8',
 *   device: 'webgpu', // fall back to 'wasm'
 *   progress_callback: (progress) => {
 *     postResult({ type: 'progress', ...progress, modelId });
 *   },
 * });
 * ```
 */
async function loadModel(id: string): Promise<void> {
  modelId = id;

  try {
    console.log(`[STT Worker] Loading model: ${id}`);

    // TODO: Initialize ONNX Runtime Web / @huggingface/transformers pipeline
    // This stub simulates a successful load after a brief delay
    await new Promise<void>((r) => setTimeout(r, 100));

    modelLoaded = true;
    postResult({ type: "ready" });
    console.log(`[STT Worker] Model "${id}" ready.`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    postResult({ type: "error", message: `Failed to load model: ${message}`, stack });
  }
}

/**
 * Transcribe a Float32Array of 16 kHz mono PCM audio.
 *
 * TODO: Implement with @huggingface/transformers:
 * ```ts
 * const result = await asr(audio, {
 *   language: 'en',
 *   task: 'transcribe',
 *   return_timestamps: false,
 * });
 * return { text: result.text.trim(), confidence: 1.0, language: 'en' };
 * ```
 */
async function transcribe(audio: Float32Array): Promise<void> {
  if (!modelLoaded) {
    postResult({ type: "error", message: "Model not loaded. Send 'load' message first." });
    return;
  }

  try {
    const durationSeconds = audio.length / 16_000;
    console.log(`[STT Worker] Transcribing ${durationSeconds.toFixed(2)}s of audio...`);

    // TODO: Replace with actual whisper inference
    // Stub: return a placeholder transcription after simulated delay
    await new Promise<void>((r) => setTimeout(r, 50));

    postResult({
      type: "result",
      text: "[STT not yet implemented]",
      confidence: 0.0,
      language: "en",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    postResult({ type: "error", message: `Transcription failed: ${message}`, stack });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

self.addEventListener("message", (event: MessageEvent<STTWorkerInput>) => {
  const msg = event.data;

  switch (msg.type) {
    case "load":
      loadModel(msg.modelId).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        postResult({ type: "error", message });
      });
      break;

    case "transcribe":
      transcribe(msg.audio).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        postResult({ type: "error", message });
      });
      break;

    default:
      console.warn(`[STT Worker] Unknown message type: ${(msg as { type: string }).type}`);
  }
});

console.log("[STT Worker] VoxPilot STT worker initialized.");
