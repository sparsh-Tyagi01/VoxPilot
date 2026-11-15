import { afterEach, describe, expect, it, vi } from "vitest";
import { VAD } from "../src/offscreen/audio/vad.js";

afterEach(() => vi.useRealTimers());
describe("VAD resource limits", () => {
  it("caps continuous noise at 30 seconds without emitting an oversized STT request", async () => {
    const onSpeechEnd = vi.fn();
    const vad = new VAD({ onSpeechStart: vi.fn(), onSpeechEnd });
    await vad.start();
    const noise = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 7) * 0.1);
    for (let i = 0; i < 235; i++) vad.processAudioChunk(noise);
    expect(onSpeechEnd).toHaveBeenCalledOnce();
    expect(onSpeechEnd.mock.calls[0]![0].length).toBe(16_000 * 30);
    vad.stop();
  });
  it("reports discarded clicks so the agent can leave Transcribing", async () => {
    vi.useFakeTimers();
    const onSpeechDiscard = vi.fn();
    const onSpeechEnd = vi.fn();
    const vad = new VAD({ onSpeechStart: vi.fn(), onSpeechEnd, onSpeechDiscard });
    await vad.start();
    vad.processAudioChunk(Float32Array.from({ length: 128 }, (_, i) => Math.sin(i / 7) * 0.1));
    vad.processAudioChunk(new Float32Array(128));
    await vi.advanceTimersByTimeAsync(300);
    expect(onSpeechDiscard).toHaveBeenCalledOnce();
    expect(onSpeechEnd).not.toHaveBeenCalled();
    vad.stop();
  });
});
