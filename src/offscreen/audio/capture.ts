/**
 * @file src/offscreen/audio/capture.ts
 * @description Real-time microphone capture using the Web Audio API.
 *
 * Uses getUserMedia with privacy-preserving constraints:
 *   - echoCancellation: true  — prevents the agent's own TTS from triggering VAD
 *   - noiseSuppression: true  — reduces background noise for better STT accuracy
 *   - autoGainControl: true   — normalizes volume across different microphones
 *
 * Audio flow:
 *   MediaStream → MediaStreamAudioSourceNode → ScriptProcessorNode* → onAudioData callback
 *   (* AudioWorklet preferred; ScriptProcessor used as fallback for compatibility)
 *
 * The captured audio is Float32Array at AUDIO_SAMPLE_RATE (16 kHz), suitable for
 * direct input to Whisper (which is also trained on 16 kHz audio).
 */

import { AUDIO_SAMPLE_RATE } from "@shared/constants.js";

/** Configuration for AudioCapture. */
export interface AudioCaptureConfig {
  /**
   * Callback invoked with each audio chunk from the microphone.
   * Called at the ScriptProcessor buffer rate (every ~64-128ms at 16 kHz).
   * @param data Float32Array of mono PCM samples at AUDIO_SAMPLE_RATE
   */
  onAudioData: (data: Float32Array) => void;

  /**
   * Optional callback for live audio volume / RMS level (0.0 to 1.0).
   * Throttled to ~10 Hz (every ~100ms) for UI VU meter feedback.
   */
  onAudioLevel?: (level: number) => void;

  /**
   * Buffer size for the ScriptProcessorNode (must be power of 2).
   * Default: 2048 (~128ms at 16 kHz) for responsive feedback.
   */
  bufferSize?: number;
}

/**
 * Resample a Float32Array audio buffer to target sample rate using linear interpolation.
 */
function resampleBuffer(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return new Float32Array(input);
  const ratio = fromRate / toRate;
  const newLength = Math.round(input.length / ratio);
  const output = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const origin = i * ratio;
    const index = Math.floor(origin);
    const decimal = origin - index;
    const s0 = input[index] ?? 0;
    const s1 = input[index + 1] ?? s0;
    output[i] = s0 + decimal * (s1 - s0);
  }
  return output;
}

/** AudioCapture manages a live microphone stream and feeds chunks to VAD. */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private gainNode: GainNode | null = null;
  private lastLevelEmitTime = 0;
  private readonly config: Required<Omit<AudioCaptureConfig, "onAudioLevel">> & Pick<AudioCaptureConfig, "onAudioLevel">;

  constructor(config: AudioCaptureConfig) {
    this.config = {
      bufferSize: 2048,
      ...config,
    };
  }

  /**
   * Request microphone access and start the audio pipeline.
   * @throws {DOMException} if the user denies microphone permission
   * @throws {NotFoundError} if no microphone is available
   */
  async start(): Promise<void> {
    if (this.stream) {
      console.warn("[AudioCapture] Already started — call stop() first.");
      return;
    }

    // Request microphone with fallback for OS compatibility
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      // Fallback with basic audio constraint (e.g. if hardware rejects advanced constraints)
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    }

    // Create AudioContext at the target sample rate (fallback to native rate if constructor rejects option)
    try {
      this.audioContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });
    } catch {
      this.audioContext = new AudioContext();
    }

    // CRITICAL: AudioContext created without direct user gesture starts suspended.
    // In suspended state, the audio clock does NOT tick and onaudioprocess never fires.
    if (this.audioContext.state === "suspended") {
      await this.audioContext.resume();
    }
    console.log(`[AudioCapture] AudioContext state: ${this.audioContext.state}, rate: ${this.audioContext.sampleRate} Hz`);

    // Connect: MediaStream → AudioSourceNode → ScriptProcessorNode → GainNode(0) → output
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.processorNode = this.audioContext.createScriptProcessor(
      this.config.bufferSize,
      1, // input channels (mono)
      1  // output channels (mono)
    );

    // Mute gain node prevents mic feedback loop through speakers while keeping graph running
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = 0;

    const nativeRate = this.audioContext.sampleRate;

    // Audio processing callback — runs at buffer boundary
    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const channelData = event.inputBuffer.getChannelData(0);

      // Resample to 16 kHz if the system AudioContext is running at 44.1k/48k
      const chunk = nativeRate === AUDIO_SAMPLE_RATE
        ? new Float32Array(channelData)
        : resampleBuffer(channelData, nativeRate, AUDIO_SAMPLE_RATE);

      // Calculate RMS audio level
      let sumSq = 0;
      for (let i = 0; i < chunk.length; i++) {
        const s = chunk[i] ?? 0;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / chunk.length);

      // Throttle audio level feedback to ~10 Hz (every 100ms)
      const now = performance.now();
      if (now - this.lastLevelEmitTime > 100) {
        this.lastLevelEmitTime = now;
        this.config.onAudioLevel?.(rms);
      }

      this.config.onAudioData(chunk);
    };

    // Connect the graph
    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.gainNode);
    this.gainNode.connect(this.audioContext.destination);

    console.log(
      `[AudioCapture] Started. Sample rate: ${this.audioContext.sampleRate} Hz ` +
      `(${nativeRate === AUDIO_SAMPLE_RATE ? "native 16k" : "resampling to 16k"}), ` +
      `buffer: ${this.config.bufferSize} frames.`
    );
  }

  /**
   * Stop audio capture and release the microphone stream.
   * Safe to call even if not started.
   */
  stop(): void {
    // Disconnect graph
    this.processorNode?.disconnect();
    this.sourceNode?.disconnect();
    this.gainNode?.disconnect();

    // Release microphone (removes the browser indicator dot)
    this.stream?.getTracks().forEach((track) => track.stop());

    // Close AudioContext
    this.audioContext?.close().catch(console.error);

    this.processorNode = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.stream = null;
    this.audioContext = null;

    console.log("[AudioCapture] Stopped and microphone released.");
  }

  /** Whether audio capture is currently active. */
  get isRunning(): boolean {
    return this.stream !== null;
  }

  /** The current AudioContext sample rate (useful for resampling checks). */
  get sampleRate(): number {
    return this.audioContext?.sampleRate ?? AUDIO_SAMPLE_RATE;
  }
}
