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
   * Called at the ScriptProcessor buffer rate (every ~21ms at 16 kHz).
   * @param data Float32Array of mono PCM samples at AUDIO_SAMPLE_RATE
   */
  onAudioData: (data: Float32Array) => void;

  /**
   * Buffer size for the ScriptProcessorNode (must be power of 2).
   * Default: 4096 (~256ms at 16 kHz)
   */
  bufferSize?: number;
}

/** AudioCapture manages a live microphone stream and feeds chunks to VAD. */
export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private readonly config: Required<AudioCaptureConfig>;

  constructor(config: AudioCaptureConfig) {
    this.config = {
      bufferSize: 4096,
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

    // Request microphone with privacy-preserving audio processing
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,          // Mono — Whisper expects mono
        sampleRate: AUDIO_SAMPLE_RATE, // 16 kHz — Whisper's native sample rate
        echoCancellation: true,   // Prevents TTS audio feedback
        noiseSuppression: true,   // Reduces background noise for STT
        autoGainControl: true,    // Normalizes microphone gain
      },
      video: false,
    });

    // Create AudioContext at the target sample rate
    this.audioContext = new AudioContext({ sampleRate: AUDIO_SAMPLE_RATE });

    // Connect: MediaStream → AudioSourceNode → ScriptProcessorNode → output (silent)
    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
    this.processorNode = this.audioContext.createScriptProcessor(
      this.config.bufferSize,
      1, // input channels (mono)
      1  // output channels (mono)
    );

    // Audio processing callback — runs at buffer boundary
    this.processorNode.onaudioprocess = (event: AudioProcessingEvent) => {
      const channelData = event.inputBuffer.getChannelData(0);
      // Clone the data before passing it to the callback
      // (the Float32Array is backed by shared memory and may be reused)
      const chunk = new Float32Array(channelData);
      this.config.onAudioData(chunk);
    };

    // Connect the graph
    this.sourceNode.connect(this.processorNode);
    // Connect to destination to keep the graph active (silent output)
    this.processorNode.connect(this.audioContext.destination);

    console.log(
      `[AudioCapture] Started. Sample rate: ${this.audioContext.sampleRate} Hz, ` +
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

    // Release microphone (removes the browser indicator dot)
    this.stream?.getTracks().forEach((track) => track.stop());

    // Close AudioContext
    this.audioContext?.close().catch(console.error);

    this.processorNode = null;
    this.sourceNode = null;
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
