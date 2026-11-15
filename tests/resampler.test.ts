import { describe, it, expect } from "vitest";
import { PCMResampler } from "../src/offscreen/audio/resampler.js";
describe("streaming audio resampling", () => {
  it.each([44100, 48000, 8000])("keeps interpolation and phase identical across chunks at %i Hz", rate => {
    const data = Float32Array.from({ length: 4097 }, (_, i) => Math.sin(i / 100));
    const expected = new PCMResampler(rate, 16000).process(data);
    const stream = new PCMResampler(rate, 16000); const samples: number[] = [];
    for (let i = 0; i < data.length; i += 137) samples.push(...stream.process(data.subarray(i, i + 137)));
    expect(samples.length).toBe(expected.length);
    samples.forEach((sample, i) => expect(sample).toBeCloseTo(expected[i]!, 6));
  });
  it("avoids copying native 16kHz packets", () => {
    const data = new Float32Array([1, 2]);
    expect(new PCMResampler(16000, 16000).process(data)).toBe(data);
  });
});
