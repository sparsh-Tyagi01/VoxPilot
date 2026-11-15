/** Streaming linear resampler preserving phase across arbitrary native-rate packet boundaries. */
export class PCMResampler {
  private tail = new Float32Array(0);
  private position = 0;
  private readonly ratio: number;
  constructor(fromRate: number, toRate: number) {
    if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate <= 0 || toRate <= 0) throw new Error("Invalid audio sample rate");
    this.ratio = fromRate / toRate;
  }
  process(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input;
    const data = new Float32Array(this.tail.length + input.length);
    data.set(this.tail); data.set(input, this.tail.length);
    const output: number[] = [];
    while (this.position < data.length - 1) {
      const index = Math.floor(this.position); const fraction = this.position - index;
      output.push(data[index]! + (data[index + 1]! - data[index]!) * fraction);
      this.position += this.ratio;
    }
    const consumed = Math.max(0, Math.min(Math.floor(this.position), data.length - 1));
    this.tail = data.slice(consumed); this.position -= consumed;
    return Float32Array.from(output);
  }
}
