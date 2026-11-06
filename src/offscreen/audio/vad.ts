/**
 * @file src/offscreen/audio/vad.ts
 * @description Voice Activity Detection (VAD) for VoxPilot.
 *
 * This is the stub/skeleton. The production implementation will use
 * silero-vad (a lightweight ONNX model for speech detection) running
 * in a Web Worker via ONNX Runtime Web.
 *
 * Current implementation: simple energy-based VAD as a placeholder.
 * Replace the `processAudioChunk` internals with silero-vad inference.
 *
 * VAD logic:
 * 1. processAudioChunk() receives 16kHz mono PCM frames
 * 2. When energy exceeds SPEECH_THRESHOLD → trigger onSpeechStart
 * 3. When energy falls below threshold → start endpoint hangover timer
 * 4. After VAD_ENDPOINT_HANGOVER_MS of silence → collect audio and trigger onSpeechEnd
 * 5. onSpeechEnd receives the full utterance Float32Array for STT
 */

import { VAD_ENDPOINT_HANGOVER_MS, MIN_SPEECH_DURATION_MS, AUDIO_SAMPLE_RATE } from "@shared/constants.js";

/** Configuration for the VAD. */
export interface VADConfig {
  /** Called when speech activity begins. */
  onSpeechStart: () => void;
  /**
   * Called when an utterance ends.
   * @param audio Complete utterance as Float32Array (16 kHz mono PCM)
   */
  onSpeechEnd: (audio: Float32Array) => void;
  /** Energy threshold for speech detection (default: 0.01). */
  speechThreshold?: number;
  /** Silence threshold (may differ from speech threshold for hysteresis). */
  silenceThreshold?: number;
}

/** States of the VAD state machine. */
type VADInternalState = "silence" | "speech" | "endpoint_hangover";

/**
 * VAD manages speech start/end detection from a continuous audio stream.
 * This stub uses simple energy-based detection; replace with silero-vad.
 */
export class VAD {
  private readonly config: Required<VADConfig>;
  private state: VADInternalState = "silence";
  private hangoverTimer: ReturnType<typeof setTimeout> | null = null;

  /** Ring buffer accumulating audio during the current utterance. */
  private speechBuffer: Float32Array[] = [];
  /** Total samples accumulated in speechBuffer. */
  private speechSamples = 0;

  /** Whether the VAD has been started. */
  private running = false;

  constructor(config: VADConfig) {
    this.config = {
      speechThreshold: 0.01,
      silenceThreshold: 0.005,
      ...config,
    };
  }

  /**
   * Start VAD processing.
   * In production, this will initialize the silero-vad ONNX model.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.state = "silence";
    this.speechBuffer = [];
    this.speechSamples = 0;

    // TODO: Initialize silero-vad ONNX Runtime Web session here
    // const session = await InferenceSession.create('/models/silero_vad.onnx');
    console.log("[VAD] Started (energy-based stub).");
  }

  /**
   * Stop VAD and cancel any pending hangover timer.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.hangoverTimer !== null) {
      clearTimeout(this.hangoverTimer);
      this.hangoverTimer = null;
    }

    this.speechBuffer = [];
    this.speechSamples = 0;
    this.state = "silence";

    // TODO: Release silero-vad ONNX session here
    console.log("[VAD] Stopped.");
  }

  /**
   * Process an audio chunk from AudioCapture.
   * Called at ~21ms intervals (4096 frames at 16 kHz).
   *
   * TODO: Replace with silero-vad chunk processing:
   * ```ts
   * const { output } = await vadSession.run({ input: chunk });
   * const speechProb = output.data[0] as number;
   * const isSpeech = speechProb > 0.5;
   * ```
   *
   * @param chunk Float32Array of mono PCM samples at 16 kHz
   */
  processAudioChunk(chunk: Float32Array): void {
    if (!this.running) return;

    // ── Stub: energy-based VAD ────────────────────────────────────────────
    const energy = this.computeRMSEnergy(chunk);
    const isSpeech = energy > this.config.speechThreshold;
    const isSilence = energy < this.config.silenceThreshold;
    // ─────────────────────────────────────────────────────────────────────

    switch (this.state) {
      case "silence":
        if (isSpeech) {
          this.state = "speech";
          this.speechBuffer = [chunk.slice()];
          this.speechSamples = chunk.length;
          this.config.onSpeechStart();
        }
        break;

      case "speech":
        // Accumulate audio
        this.speechBuffer.push(chunk.slice());
        this.speechSamples += chunk.length;

        if (isSilence) {
          // Start endpoint hangover
          this.state = "endpoint_hangover";
          this.hangoverTimer = setTimeout(() => {
            this.finalizeUtterance();
          }, VAD_ENDPOINT_HANGOVER_MS);
        }
        break;

      case "endpoint_hangover":
        // Continue accumulating audio during hangover
        this.speechBuffer.push(chunk.slice());
        this.speechSamples += chunk.length;

        if (isSpeech) {
          // Speech resumed — cancel hangover, go back to speech state
          if (this.hangoverTimer !== null) {
            clearTimeout(this.hangoverTimer);
            this.hangoverTimer = null;
          }
          this.state = "speech";
        }
        // If silence continues, the setTimeout will fire finalizeUtterance()
        break;
    }
  }

  /**
   * Finalize the current utterance and emit it via onSpeechEnd.
   */
  private finalizeUtterance(): void {
    this.hangoverTimer = null;
    this.state = "silence";

    // Check minimum duration
    const durationMs = (this.speechSamples / AUDIO_SAMPLE_RATE) * 1000;
    if (durationMs < MIN_SPEECH_DURATION_MS) {
      console.debug(`[VAD] Utterance too short (${durationMs.toFixed(0)}ms) — ignoring.`);
      this.speechBuffer = [];
      this.speechSamples = 0;
      return;
    }

    // Concatenate all chunks into a single Float32Array
    const utterance = this.concatenateChunks(this.speechBuffer, this.speechSamples);
    this.speechBuffer = [];
    this.speechSamples = 0;

    console.debug(`[VAD] Utterance ended: ${durationMs.toFixed(0)}ms, ${utterance.length} samples.`);
    this.config.onSpeechEnd(utterance);
  }

  /**
   * Compute the RMS energy of an audio chunk.
   * Used for the energy-based VAD stub.
   */
  private computeRMSEnergy(chunk: Float32Array): number {
    let sumSquares = 0;
    for (let i = 0; i < chunk.length; i++) {
      const sample = chunk[i] ?? 0;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / chunk.length);
  }

  /**
   * Concatenate an array of Float32Array chunks into a single buffer.
   */
  private concatenateChunks(chunks: Float32Array[], totalLength: number): Float32Array {
    const result = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /** Current VAD state (for debugging/diagnostics). */
  get currentState(): VADInternalState {
    return this.state;
  }
}
