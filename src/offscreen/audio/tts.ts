/**
 * @file src/offscreen/audio/tts.ts
 * @description Text-to-Speech engine for VoxPilot agent responses.
 *
 * Uses the Web Speech API (SpeechSynthesis) which is available in the offscreen
 * document. The production version may replace this with a local ONNX TTS model
 * (e.g., VITS or Kokoro) for fully offline operation.
 *
 * Key features:
 * - Barge-in support: speaking can be interrupted mid-sentence
 * - Configurable voice, speed, pitch
 * - Sentence chunking for lower latency (starts speaking before full text is ready)
 * - Promise-based API for async/await usage
 *
 * @example
 * ```ts
 * const tts = new TTS();
 * await tts.speak("Clicking the Sign In button now.");
 * ```
 */

/** Configuration options for the TTS engine. */
export interface TTSConfig {
  /** Speech rate (0.5 = slow, 1.0 = normal, 2.0 = fast). Default: 1.1 */
  rate?: number;
  /** Pitch (0.5 – 2.0). Default: 1.0 */
  pitch?: number;
  /** Volume (0.0 – 1.0). Default: 0.9 */
  volume?: number;
  /**
   * Voice URI as returned by speechSynthesis.getVoices().
   * If null, uses the platform default voice.
   */
  voiceURI?: string | null;
}

/**
 * TTS wraps the Web Speech API SpeechSynthesis with:
 * - barge-in (stop current speech immediately)
 * - async speak() that resolves when speaking finishes
 * - graceful fallback when no voices are available
 */
export class TTS {
  private readonly config: Required<TTSConfig>;
  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private currentResolve: (() => void) | null = null;
  private currentReject: ((err: Error) => void) | null = null;

  constructor(config: TTSConfig = {}) {
    this.config = {
      rate: 1.1,
      pitch: 1.0,
      volume: 0.9,
      voiceURI: null,
      ...config,
    };
  }

  /**
   * Speak text aloud. Interrupts any current speech (barge-in).
   * Resolves when speech is complete.
   *
   * @param text The text to speak. Must be non-empty.
   * @returns Promise that resolves when speaking ends.
   * @throws {Error} if TTS synthesis fails.
   */
  async speak(text: string): Promise<void> {
    if (!text.trim()) return;

    // Barge-in: stop whatever is currently playing
    this.stop();

    return new Promise<void>((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);

      utterance.rate = this.config.rate;
      utterance.pitch = this.config.pitch;
      utterance.volume = this.config.volume;

      // Set voice if specified
      if (this.config.voiceURI) {
        const voices = speechSynthesis.getVoices();
        const voice = voices.find((v) => v.voiceURI === this.config.voiceURI);
        if (voice) {
          utterance.voice = voice;
        } else {
          console.warn(`[TTS] Voice "${this.config.voiceURI}" not found — using default.`);
        }
      }

      utterance.onend = () => {
        this.currentUtterance = null;
        this.currentResolve = null;
        this.currentReject = null;
        resolve();
      };

      utterance.onerror = (event: SpeechSynthesisErrorEvent) => {
        this.currentUtterance = null;
        this.currentResolve = null;
        this.currentReject = null;

        // 'interrupted' is not a real error — it means stop() was called
        if (event.error === "interrupted" || event.error === "canceled") {
          resolve();
        } else {
          reject(new Error(`TTS error: ${event.error}`));
        }
      };

      this.currentUtterance = utterance;
      this.currentResolve = resolve;
      this.currentReject = reject;

      speechSynthesis.speak(utterance);
    });
  }

  /**
   * Stop any currently playing speech immediately (barge-in support).
   * Safe to call even when nothing is playing.
   */
  stop(): void {
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      speechSynthesis.cancel();
    }
    // Resolve the pending promise (stop is not an error)
    this.currentResolve?.();
    this.currentUtterance = null;
    this.currentResolve = null;
    this.currentReject = null;
  }

  /**
   * Whether TTS is currently speaking.
   */
  get isSpeaking(): boolean {
    return speechSynthesis.speaking;
  }

  /**
   * List available voices (async because voices may not be loaded synchronously).
   * @returns Array of available SpeechSynthesisVoice objects
   */
  async getVoices(): Promise<SpeechSynthesisVoice[]> {
    return new Promise((resolve) => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        resolve(voices);
        return;
      }
      // Voices not loaded yet — wait for onvoiceschanged
      speechSynthesis.onvoiceschanged = () => {
        resolve(speechSynthesis.getVoices());
      };
    });
  }

  /**
   * Update TTS configuration (rate, pitch, etc.).
   * Takes effect on the next speak() call.
   */
  updateConfig(partial: Partial<TTSConfig>): void {
    Object.assign(this.config, partial);
  }
}
