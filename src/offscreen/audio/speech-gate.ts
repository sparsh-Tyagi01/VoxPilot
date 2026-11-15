/** Cheap pre-ASR guard. DC offset, empty packets and low-energy noise are not speech evidence. */
export function speechEnergy(audio: Float32Array): number {
  if (!audio.length) return 0;
  let mean = 0;
  for (const value of audio) { if (!Number.isFinite(value)) return 0; mean += value; }
  mean /= audio.length;
  let sum = 0;
  for (const value of audio) sum += (value - mean) ** 2;
  return Math.sqrt(sum / audio.length);
}
export function hasUsableSpeech(audio: Float32Array): boolean {
  if (audio.length < 3200 || audio.length > 480_000) return false;
  let active = 0;
  for (let i = 0; i < audio.length; i += 320) {
    if (speechEnergy(audio.subarray(i, i + 320)) >= 0.006) active += Math.min(320, audio.length - i);
  }
  return active >= 2400; // At least 150 ms of non-silent audio, excluding endpoint silence.
}
