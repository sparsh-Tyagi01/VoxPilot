/** Bounded neural voice detector with conservative energy fallback if initialization fails. */
import { AUDIO_SAMPLE_RATE, MIN_SPEECH_DURATION_MS, VAD_ENDPOINT_HANGOVER_MS } from "@shared/constants.js";
import { hasUsableSpeech, speechEnergy } from "./speech-gate.js";
export interface VADConfig {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onSpeechDiscard?: () => void;
  speechThreshold?: number;
  silenceThreshold?: number;
}
export class VAD {
  private running = false;
  private state: "silence" | "speech" = "silence";
  private worker: Worker | null = null;
  private ready = false;
  private pending = false;
  private epoch = 0;
  private packet = new Float32Array(512);
  private filled = 0;
  private frames: Float32Array[] = [];
  private voiced = 0;
  private total = 0;
  private silence = 0;
  private preRoll: Float32Array[] = [];
  private queue: Float32Array[] = [];
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly config: VADConfig) {}
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.resetUtterance();
    if (this.worker || typeof Worker === "undefined") return;
    let worker: Worker;
    try { worker = new Worker(new URL("./vad-worker.ts", import.meta.url), { type: "module" }); }
    catch { return; } // Keep the conservative energy path available.
    this.worker = worker;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { this.disableWorker(); resolve(); }, 10_000);
      worker.addEventListener("error", () => { if (this.worker !== worker) return; clearTimeout(timer); this.disableWorker(); resolve(); });
      worker.addEventListener("message", (event: MessageEvent<{ type: string; epoch: number; probability: number; audio: Float32Array }>) => {
        if (this.worker !== worker) return;
        if (event.data.type === "ready") { this.ready = true; clearTimeout(timer); resolve(); return; }
        if (event.data.type === "error") { clearTimeout(timer); this.disableWorker(); resolve(); return; }
        if (this.frameTimer) clearTimeout(this.frameTimer);
        this.frameTimer = null;
        this.pending = false;
        if (this.running && event.data.epoch === this.epoch) this.accept(event.data.audio, event.data.probability);
        this.dispatch();
      });
      worker.postMessage({ type: "load", epoch: this.epoch });
    });
  }
  stop(): void {
    this.running = false;
    this.resetUtterance();
  }
  get currentState(): "silence" | "speech" { return this.state; }
  private resetUtterance(): void {
    this.epoch++; this.filled = 0; this.queue = []; this.frames = []; this.preRoll = [];
    this.total = 0; this.voiced = 0; this.silence = 0; this.state = "silence";
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
    if (this.ready) this.worker?.postMessage({ type: "reset", epoch: this.epoch });
  }
  private disableWorker(): void {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    this.worker?.terminate(); this.worker = null; this.ready = false; this.pending = false;
    this.resetUtterance(); this.config.onSpeechDiscard?.();
  }
  processAudioChunk(chunk: Float32Array): void {
    if (!this.running || !chunk.length) return;
    if (!this.ready) {
      const energy = speechEnergy(chunk);
      const threshold = this.config.speechThreshold ?? 0.012;
      this.accept(chunk, energy >= threshold ? 0.9 : 0);
      return;
    }
    for (let offset = 0; offset < chunk.length;) {
      const count = Math.min(512 - this.filled, chunk.length - offset);
      this.packet.set(chunk.subarray(offset, offset + count), this.filled);
      this.filled += count; offset += count;
      if (this.filled === 512) {
        if (this.queue.length >= 4) {
          this.resetUtterance(); this.config.onSpeechDiscard?.(); return;
        }
        this.queue.push(this.packet); this.packet = new Float32Array(512); this.filled = 0;
      }
    }
    this.dispatch();
  }
  private dispatch(): void {
    if (!this.running || !this.ready || this.pending || !this.queue.length) return;
    const audio = this.queue.shift()!; this.pending = true;
    this.worker!.postMessage({ type: "frame", epoch: this.epoch, audio }, [audio.buffer]);
    this.frameTimer = setTimeout(() => this.disableWorker(), 1500);
  }
  private accept(audio: Float32Array, probability: number): void {
    if (!Number.isFinite(probability)) return;
    const speech = probability >= 0.6 && speechEnergy(audio) >= 0.006;
    if (this.state === "silence") {
      this.preRoll.push(audio.slice()); if (this.preRoll.length > 3) this.preRoll.shift();
      if (!speech) return;
      this.state = "speech"; this.frames = this.preRoll; this.preRoll = [];
      this.total = this.frames.reduce((sum, frame) => sum + frame.length, 0);
      this.voiced = audio.length; this.config.onSpeechStart();
    } else {
      this.frames.push(audio.slice()); this.total += audio.length;
      if (speech) this.voiced += audio.length;
    }
    if (speech) {
      this.silence = 0;
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    } else {
      this.silence += audio.length;
      if (!this.ready && !this.fallbackTimer) this.fallbackTimer = setTimeout(() => this.finish(), VAD_ENDPOINT_HANGOVER_MS);
      if (this.silence >= AUDIO_SAMPLE_RATE * VAD_ENDPOINT_HANGOVER_MS / 1000) this.finish();
    }
    if (this.total >= AUDIO_SAMPLE_RATE * 30) this.finish();
  }
  private finish(): void {
    const enoughVoice = this.voiced >= AUDIO_SAMPLE_RATE * (this.ready ? 160 : MIN_SPEECH_DURATION_MS) / 1000;
    const audio = new Float32Array(Math.min(this.total, AUDIO_SAMPLE_RATE * 30));
    let offset = 0;
    for (const frame of this.frames) {
      const part = frame.subarray(0, audio.length - offset); audio.set(part, offset); offset += part.length;
      if (offset >= audio.length) break;
    }
    this.resetUtterance();
    if (enoughVoice && hasUsableSpeech(audio)) this.config.onSpeechEnd(audio);
    else this.config.onSpeechDiscard?.();
  }
}
