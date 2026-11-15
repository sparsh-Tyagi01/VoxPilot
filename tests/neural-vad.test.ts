import { afterEach, expect, it, vi } from "vitest";
import { VAD } from "../src/offscreen/audio/vad.js";
class WorkerStub {
  static instance: WorkerStub;
  listeners = new Map<string, (event: { data: unknown }) => void>();
  postMessage = vi.fn(); terminate = vi.fn();
  constructor() { WorkerStub.instance = this; }
  addEventListener(type: string, listener: (event: { data: unknown }) => void) { this.listeners.set(type, listener); }
  emit(data: unknown) { this.listeners.get("message")?.({ data }); }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it("digital silence never starts recognition; stale classifier output after pause is ignored", async () => {
  vi.stubGlobal("Worker", WorkerStub);
  const start = vi.fn(); const end = vi.fn();
  const vad = new VAD({ onSpeechStart: start, onSpeechEnd: end });
  const loading = vad.start(); const worker = WorkerStub.instance;
  worker.emit({ type: "ready" }); await loading;
  for (let i = 0; i < 100; i++) {
    const audio = new Float32Array(512); vad.processAudioChunk(audio);
    const frame = worker.postMessage.mock.calls.at(-1)![0];
    worker.emit({ type: "probability", probability: 0.1, epoch: frame.epoch, audio });
  }
  expect(start).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
  const audio = Float32Array.from({ length: 512 }, (_, i) => Math.sin(i / 7) * 0.1);
  vad.processAudioChunk(audio); const frame = worker.postMessage.mock.calls.at(-1)![0];
  vad.stop(); worker.emit({ type: "probability", probability: 0.99, epoch: frame.epoch, audio });
  expect(start).not.toHaveBeenCalled();
});
it("bounds an unresponsive classifier instead of growing an audio queue", async () => {
  vi.useFakeTimers(); vi.stubGlobal("Worker", WorkerStub);
  const vad = new VAD({ onSpeechStart: vi.fn(), onSpeechEnd: vi.fn() });
  const loading = vad.start(); const worker = WorkerStub.instance; worker.emit({ type: "ready" }); await loading;
  for (let i = 0; i < 100; i++) vad.processAudioChunk(new Float32Array(512));
  expect(worker.postMessage.mock.calls.filter(([message]) => message.type === "frame")).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1500); expect(worker.terminate).toHaveBeenCalledOnce(); vad.stop();
});
it("emits one utterance after sustained speech and the endpoint silence", async () => {
  vi.stubGlobal("Worker", WorkerStub);
  const start = vi.fn(); const end = vi.fn();
  const vad = new VAD({ onSpeechStart: start, onSpeechEnd: end });
  const loading = vad.start(); const worker = WorkerStub.instance; worker.emit({ type: "ready" }); await loading;
  for (let i = 0; i < 25; i++) {
    const speaking = i < 10;
    const audio = speaking ? Float32Array.from({ length: 512 }, (_, n) => Math.sin(n / 7) * 0.1) : new Float32Array(512);
    vad.processAudioChunk(audio);
    const frame = worker.postMessage.mock.calls.at(-1)![0];
    worker.emit({ type: "probability", probability: speaking ? 0.95 : 0.03, epoch: frame.epoch, audio });
  }
  expect(start).toHaveBeenCalledOnce(); expect(end).toHaveBeenCalledOnce();
  expect(end.mock.calls[0]![0].length).toBe(20 * 512);
  vad.stop();
});
