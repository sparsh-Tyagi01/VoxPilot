import { describe, expect, it } from "vitest";
import { hasUsableSpeech, speechEnergy } from "../src/offscreen/audio/speech-gate.js";
describe("silence guards", () => {
  it("rejects silence, DC bias, tiny noise and single clicks before recognition", () => {
    const click = new Float32Array(16000); click[100] = 1;
    for (const input of [new Float32Array(16000), new Float32Array(16000).fill(0.1), Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i) * 0.001), click]) {
      expect(hasUsableSpeech(input)).toBe(false);
    }
    expect(speechEnergy(new Float32Array([NaN]))).toBe(0);
  });
  it("preserves sufficiently energetic nonconstant speech input", () => {
    expect(hasUsableSpeech(Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 7) * 0.05))).toBe(true);
  });
});
